import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type {
  PaperclipPlugin,
  PluginContext,
  PluginHealthDiagnostics,
  PluginJobContext,
  PluginWebhookInput,
} from "@paperclipai/plugin-sdk";
import { createBridgeClient } from "@paperclipai/adapter-utils";
import { JOB_KEYS, WEBHOOK_KEYS } from "./constants.js";

// ---------------------------------------------------------------------------
// Bridge tool registration with retry
// ---------------------------------------------------------------------------

async function resolveBridgeUrl(envUrl: string): Promise<string> {
  if (process.env.AI_TOOLS_BRIDGE_URL) return process.env.AI_TOOLS_BRIDGE_URL;
  const candidates =
    envUrl === "http://ai-tools-bridge:8000"
      ? ["http://localhost:8000", "http://ai-tools-bridge:8000"]
      : [envUrl];
  for (const url of candidates) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return url;
    } catch { /* try next */ }
  }
  return envUrl;
}

async function registerBridgeTools(
  ctx: PluginContext,
  packageSlug: string,
  configuredUrl: string,
  buildCredentials: (config: ReturnType<typeof getConfig> extends Promise<infer T> ? T : never) => Promise<Record<string, unknown>>,
  logPrefix: string,
): Promise<void> {
  const delays = [2_000, 5_000, 10_000, 20_000, 30_000, 60_000, 120_000, 180_000];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const bridgeUrl = await resolveBridgeUrl(configuredUrl);
      const bridge = createBridgeClient(bridgeUrl, packageSlug);
      const tools = await bridge.getToolManifest();
      for (const tool of tools) {
        ctx.tools.register(
          tool.name,
          { displayName: tool.display_name, description: tool.description, parametersSchema: tool.parameters_schema },
          async (params, _runCtx) => {
            const config = await getConfig(ctx);
            const credentials = await buildCredentials(config);
            const execUrl = await resolveBridgeUrl(configuredUrl);
            const execBridge = createBridgeClient(execUrl, packageSlug);
            const result = await execBridge.execute(tool.name, params as Record<string, unknown>, credentials);
            if (result.error) return { error: result.error };
            return { content: result.content, data: result.data };
          },
        );
      }
      ctx.logger.info(`${logPrefix}: registered tools from bridge`, { count: tools.length, bridgeUrl });
      return;
    } catch (err) {
      if (attempt === delays.length) {
        ctx.logger.warn(`${logPrefix}: bridge unavailable after all retries — tools not registered`, { configuredUrl, error: (err as Error).message });
        return;
      }
      ctx.logger.debug(`${logPrefix}: bridge not ready, retrying in ${delays[attempt]! / 1000}s`, { attempt });
      await new Promise((r) => setTimeout(r, delays[attempt]!));
    }
  }
}

// ---------------------------------------------------------------------------
// Config shape
// ---------------------------------------------------------------------------

type ConfluenceConfig = {
  confluenceBaseUrl?: string;
  confluenceTokenSecretRef?: string;
  confluenceUserEmail?: string;
  spaceKeys?: string;
  syncIntervalMinutes?: number;
};

let currentContext: PluginContext | null = null;
let currentBridgeUrl: string = "http://ai-tools-bridge:8000";

async function getConfig(ctx: PluginContext): Promise<ConfluenceConfig> {
  const raw = await ctx.config.get();
  return raw as ConfluenceConfig;
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx) {
    currentContext = ctx;
    ctx.logger.info("confluence plugin setup starting");

    // ----- Events --------------------------------------------------------
    ctx.events.on("issue.created", async (event) => {
      ctx.logger.debug("issue.created event received", { event });
      // TODO: auto-link Confluence pages when issue contains Confluence URLs
    });

    // ----- Jobs ----------------------------------------------------------
    ctx.jobs.register(JOB_KEYS.sync, async (job: PluginJobContext) => {
      ctx.logger.info("confluence sync job running");
      const config = await getConfig(ctx);

      if (!config.confluenceBaseUrl || !config.confluenceTokenSecretRef) {
        ctx.logger.warn("confluence sync skipped — base URL or token not configured");
        return;
      }

      // TODO: resolve secret, poll Confluence REST API for recently updated pages
      //       in configured spaces, index page content for agent retrieval
    });

    // ----- Data handlers (UI bridge) -------------------------------------
    ctx.data.register("sync-status", async () => {
      const lastSync = await ctx.state.get({ scopeKind: "instance", stateKey: "last-sync-at" });
      const errorCount = await ctx.state.get({ scopeKind: "instance", stateKey: "sync-error-count" });
      const indexedPages = await ctx.state.get({ scopeKind: "instance", stateKey: "indexed-page-count" });
      return {
        lastSyncAt: lastSync ?? null,
        errorCount: errorCount ?? 0,
        indexedPages: indexedPages ?? 0,
        configured: !!(await getConfig(ctx)).confluenceBaseUrl,
      };
    });

    ctx.data.register("linked-pages", async (params) => {
      const issueId = params.issueId as string | undefined;
      if (!issueId) return [];
      const pages = await ctx.state.get({ scopeKind: "instance", stateKey: `page-links:${issueId}` });
      return pages ?? [];
    });

    // ----- Actions (UI bridge) -------------------------------------------
    ctx.actions.register("trigger-sync", async () => {
      ctx.logger.info("manual confluence sync triggered from UI");
      // TODO: run sync logic on demand
      return { ok: true };
    });

    // ----- Tools --------------------------------------------------------
    const bridgeUrl = process.env.AI_TOOLS_BRIDGE_URL ?? "http://ai-tools-bridge:8000";
    currentBridgeUrl = bridgeUrl;

    void registerBridgeTools(
      ctx,
      "confluence",
      bridgeUrl,
      async (config) => {
        const credentials: Record<string, unknown> = {};
        if (config.confluenceBaseUrl) credentials["confluence_base_url"] = config.confluenceBaseUrl;
        if (config.confluenceTokenSecretRef) {
          try {
            credentials["token"] = await ctx.secrets.resolve(config.confluenceTokenSecretRef);
          } catch {
            ctx.logger.warn("confluence: failed to resolve token secret", { ref: config.confluenceTokenSecretRef });
          }
        }
        if (config.confluenceUserEmail) credentials["user_email"] = config.confluenceUserEmail;
        return credentials;
      },
      "confluence plugin",
    );

    ctx.logger.info("confluence plugin setup complete");
  },

  async onWebhook(input: PluginWebhookInput) {
    const ctx = currentContext;
    if (!ctx) return;

    ctx.logger.info("confluence inbound webhook received", {
      endpointKey: input.endpointKey,
      requestId: input.requestId,
    });

    if (input.endpointKey !== WEBHOOK_KEYS.inbound) return;

    // TODO: parse Confluence webhook payload, handle page_created,
    //       page_updated, comment_created events
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    const ctx = currentContext;
    if (!ctx) return { status: "degraded", message: "Confluence plugin not yet initialized" };
    const config = await getConfig(ctx);
    const configured = !!config.confluenceBaseUrl && !!config.confluenceTokenSecretRef;

    const resolvedUrl = await resolveBridgeUrl(currentBridgeUrl);
    const bridge = createBridgeClient(resolvedUrl, "confluence");
    const bridgeOk = await bridge.isHealthy();

    if (!configured) {
      return { status: "degraded", message: "Confluence plugin loaded but not configured — set Base URL and token in settings" };
    }
    if (!bridgeOk) {
      return { status: "degraded", message: `Confluence plugin configured but AI tools bridge is unreachable at ${currentBridgeUrl}` };
    }
    return { status: "ok", message: "Confluence plugin configured and ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
