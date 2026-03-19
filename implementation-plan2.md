# BMAD Copilot Factory — Implementation Plan v2

**Goal:** Wire the Paperclip CEO agent to use GitHub Copilot SDK as its LLM provider, and orchestrate the full BMAD agent pipeline autonomously — from user issue input through brainstorming, research, PRD, architecture, epics/stories, implementation, code review, and delivery.

**Date:** March 19, 2026

---

## Table of Contents

1. [Answers to Your Questions](#answers-to-your-questions)
2. [How Paperclip Orchestration Works](#how-paperclip-orchestration-works)
3. [BMAD Skills & Agents Inventory](#bmad-skills--agents-inventory)
4. [CEO Agent ↔ GitHub Copilot Integration](#ceo-agent--github-copilot-integration)
5. [Agent MD File Configuration in Paperclip](#agent-md-file-configuration-in-paperclip)
6. [Implementation Roadmap](#implementation-roadmap)

---

## 1. Answers to Your Questions

### Q1: "My CEO agent needs an LLM provider — switch to GitHub Copilot"

**Current state:** The CEO role template (`templates/roles/bmad-ceo/role.json`) has `"copilotAgent": null` and `"heartbeat.type": "paperclip-native"` — it was designed as Paperclip-only with no LLM backing. This is the problem.

**Solution:** Switch the CEO agent's adapter type in Paperclip from a traditional LLM adapter (like `claude_local` which requires `ANTHROPIC_API_KEY`) to the **`process` adapter** that spawns your BMAD Copilot Factory as a child process. The Copilot SDK already handles LLM access via `gh auth` — no API keys needed.

The flow becomes:
```
Paperclip heartbeat → process adapter → `npx tsx src/ceo-entrypoint.ts` → Copilot SDK → GitHub Copilot LLM
```

You already have the Copilot CLI (`1.0.9`) and `gh auth` configured. The Copilot SDK (`@github/copilot-sdk`) connects to GitHub Copilot's models (Claude Sonnet 4.5, GPT-4o, etc.) using your existing GitHub authentication. **No additional LLM provider or API key is needed.**

### Q2: "CEO should orchestrate the full pipeline"

**Yes, this is the right architecture.** Paperclip's CEO is the root of the org tree. When you create an issue like "Build a note-taking app", the CEO:

1. Reviews the issue via the heartbeat protocol
2. Creates subtasks and delegates to specialized agents
3. Each agent wakes on assignment, does its work via Copilot SDK + BMAD skills, reports back via issue comments
4. CEO monitors progress, escalates blockers, approves key decisions

The BMAD skills already cover the entire software lifecycle — they just need to be mapped to Paperclip agents.

### Q3: "Which BMAD skills/agents/workflows map to Paperclip agents?"

See [Section 3: BMAD Skills & Agents Inventory](#bmad-skills--agents-inventory) below for the complete mapping.

### Q4: "How does Paperclip orchestration work?"

See [Section 2: How Paperclip Orchestration Works](#how-paperclip-orchestration-works) below.

### Q5: "How do I configure the MD files for each agent in Paperclip?"

See [Section 5: Agent MD File Configuration in Paperclip](#agent-md-file-configuration-in-paperclip) below.

---

## 2. How Paperclip Orchestration Works

### 2.1 Core Model

Paperclip is a **control plane, not an execution plane**. It doesn't run agents — it orchestrates them. The key concepts:

| Concept | Description |
|---------|-------------|
| **Company** | Top-level org unit with a goal, budget, and employees (AI agents) |
| **Agents** | AI employees in a strict org tree. Each has an adapter, role, budget, heartbeat config |
| **Issues** | Units of work. Hierarchy traces back to company goal. Status: `backlog → todo → in_progress → in_review → done` (also `blocked`, `cancelled`) |
| **Heartbeats** | Short execution windows. Agents wake, check inbox, do work, update status, exit |
| **Governance** | Board (human) approvals for hiring agents, CEO strategy, budget changes |

### 2.2 The Heartbeat Protocol (How Agents Actually Work)

Every agent follows this protocol on each heartbeat (from Paperclip's `skills/paperclip/SKILL.md`):

```
Step 1 — Identity:     GET /api/agents/me (get role, chain of command, budget)
Step 2 — Approvals:    Handle any pending PAPERCLIP_APPROVAL_ID
Step 3 — Assignments:  GET /api/agents/me/inbox-lite (compact task list)
Step 4 — Pick work:    Prioritize in_progress > todo > blocked
Step 5 — Checkout:     POST /api/issues/{id}/checkout (atomic lock)
Step 6 — Context:      GET /api/issues/{id}/heartbeat-context (ancestors, comments)
Step 7 — Do the work:  Use tools, skills, write code, research, etc.
Step 8 — Update:       PATCH /api/issues/{id} with status + comment
Step 9 — Delegate:     POST /api/companies/{id}/issues to create subtasks
```

**Key env vars auto-injected** by Paperclip into each heartbeat:
- `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`
- `PAPERCLIP_API_KEY` (short-lived run JWT for local adapters)
- `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`

### 2.3 Adapter Model (How Agents Run)

Adapters bridge Paperclip and agent runtimes. For your use case:

| Adapter | Type | When to Use |
|---------|------|-------------|
| `claude_local` | CLI | Requires `ANTHROPIC_API_KEY` ❌ (you don't have) |
| `codex_local` | CLI | Requires `OPENAI_API_KEY` ❌ (you don't have) |
| `process` | Shell | Executes any command ✅ **Best fit for Copilot SDK** |
| `http` | Webhook | External service ✅ Alternative (more complex) |

**The `process` adapter is ideal.** Config:
```json
{
  "adapterType": "process",
  "adapterConfig": {
    "command": "npx tsx src/heartbeat-entrypoint.ts",
    "cwd": "/Users/Q543651/repos/AI Repo/BMAD_Copilot_RT",
    "timeoutSec": 600,
    "env": {}
  }
}
```

Paperclip injects `PAPERCLIP_*` env vars → your process reads them → routes to the right BMAD agent → Copilot SDK does the LLM call → results go back via Paperclip API issue comments.

### 2.4 Org Chart (Push Model)

```
Board (Human You)
   │
   └── CEO (Paperclip-native + Copilot SDK via process adapter)
        ├── PM (Product Manager)
        │    ├── Developer
        │    └── Scrum Master
        └── Architect
             └── QA / Code Reviewer
```

- CEO creates top-level issues from the company goal
- CEO delegates subtasks to PM, Architect
- PM creates stories, assigns to Developer
- Developer implements, moves to review
- QA reviews, approves or sends back
- CEO monitors dashboard, unblocks, approves hires

### 2.5 Agent Orchestration Flow for a Software Issue

When you input "I need to solve a software issue" as a Paperclip issue:

```
┌─ Human creates issue: "Build feature X" ─────────────────────────┐
│                                                                    │
│  1. CEO wakes (heartbeat) → reads issue                           │
│  2. CEO creates subtasks:                                          │
│     a. "Research: brainstorm approaches" → assigns PM              │
│     b. "Research: market analysis" → assigns Analyst               │
│     c. "Research: technical feasibility" → assigns Architect       │
│                                                                    │
│  3. PM wakes → runs bmad-brainstorming, bmad-market-research      │
│     → posts findings as issue comment                              │
│                                                                    │
│  4. Architect wakes → runs bmad-technical-research,                │
│     bmad-create-architecture → posts architecture doc              │
│                                                                    │
│  5. CEO wakes → reviews outputs → creates next subtasks:           │
│     a. "Create PRD" → assigns PM                                   │
│     b. "Create UX design" → assigns UX Designer                   │
│                                                                    │
│  6. PM wakes → runs bmad-create-prd → posts PRD                   │
│                                                                    │
│  7. CEO wakes → reviews PRD → creates subtask:                    │
│     "Create epics & stories" → assigns PM                          │
│                                                                    │
│  8. PM wakes → runs bmad-create-epics-and-stories                 │
│     → creates individual story issues, assigns Developer           │
│                                                                    │
│  9. Developer wakes → runs bmad-dev-story per story               │
│     → implements code → moves to review                            │
│                                                                    │
│ 10. QA wakes → runs bmad-code-review per story                    │
│     → approves or blocks with findings                             │
│                                                                    │
│ 11. CEO monitors dashboard, handles blockers/escalations           │
└────────────────────────────────────────────────────────────────────┘
```

---

## 3. BMAD Skills & Agents Inventory

### 3.1 Available BMAD Agents (Already in Copilot SDK)

These are already defined in `src/agents/` and registered with the Copilot SDK:

| Agent | ID | Copilot SDK | Paperclip Role |
|-------|----|-------------|----------------|
| Product Manager (John) | `bmad-pm` | ✅ | `manager` |
| Architect (Alex) | `bmad-architect` | ✅ | `architect` |
| Developer (Dev) | `bmad-dev` | ✅ | `engineer` |
| QA Engineer | `bmad-qa` | ✅ | `engineer` |
| Scrum Master | `bmad-sm` | ✅ | `manager` |
| Analyst | `bmad-analyst` | ✅ | `researcher` |
| UX Designer | `bmad-ux-designer` | ✅ | `designer` |
| Tech Writer | `bmad-tech-writer` | ✅ | `engineer` |
| Quick-Flow Solo Dev | `bmad-quick-flow-solo-dev` | ✅ | `engineer` |

### 3.2 BMAD Skills Catalog (56 Skills in `skills/` directory)

Organized by pipeline phase:

#### Phase A — Discovery & Research
| Skill | Description | Agent |
|-------|-------------|-------|
| `bmad-brainstorming` | Interactive brainstorming using creative techniques | PM / Analyst |
| `bmad-market-research` | Market research on competition & customers | PM / Analyst |
| `bmad-domain-research` | Domain and industry research | Analyst |
| `bmad-technical-research` | Technical research on technologies & architecture | Architect |
| `bmad-advanced-elicitation` | Push LLM to refine and improve output | Any |

#### Phase B — Product Definition
| Skill | Description | Agent |
|-------|-------------|-------|
| `bmad-create-product-brief` | Create product brief through discovery | PM |
| `bmad-product-brief-preview` | Create/update product briefs | PM |
| `bmad-create-prd` | Create PRD from scratch | PM |
| `bmad-edit-prd` | Edit existing PRD | PM |
| `bmad-validate-prd` | Validate PRD against standards | PM |
| `bmad-create-ux-design` | Plan UX patterns and design specs | UX Designer |

#### Phase C — Architecture & Design
| Skill | Description | Agent |
|-------|-------------|-------|
| `bmad-create-architecture` | Create architecture solution design | Architect |
| `bmad-check-implementation-readiness` | Validate PRD + UX + Arch specs complete | PM |

#### Phase D — Sprint Planning & Stories
| Skill | Description | Agent |
|-------|-------------|-------|
| `bmad-create-epics-and-stories` | Break requirements into epics and stories | PM |
| `bmad-create-story` | Create dedicated story file with context | PM |
| `bmad-sprint-planning` | Generate sprint status tracking from epics | SM |
| `bmad-sprint-status` | Summarize sprint status and surface risks | SM |

#### Phase E — Implementation
| Skill | Description | Agent |
|-------|-------------|-------|
| `bmad-dev-story` | Execute story implementation from spec file | Developer |
| `bmad-quick-dev` | Implement quick tech spec for small changes | Developer |
| `bmad-quick-dev-new-preview` | Implement any user intent/requirement | Developer |
| `bmad-quick-spec` | Create quick tech spec for small changes | Developer |
| `bmad-quick-flow-solo-dev` | Full solo dev flow | Solo Dev |

#### Phase F — Quality & Review
| Skill | Description | Agent |
|-------|-------------|-------|
| `bmad-code-review` | Adversarial code review with parallel review layers | QA |
| `bmad-review-adversarial-general` | Cynical review producing findings report | QA |
| `bmad-review-edge-case-hunter` | Exhaustive edge-case analysis | QA |
| `bmad-qa-generate-e2e-tests` | Generate e2e automated tests | QA |

#### Phase G — Testing Architecture
| Skill | Description | Agent |
|-------|-------------|-------|
| `bmad-testarch-atdd` | Generate failing acceptance tests (TDD) | QA |
| `bmad-testarch-automate` | Expand test automation coverage | QA |
| `bmad-testarch-ci` | Scaffold CI/CD quality pipeline | QA |
| `bmad-testarch-framework` | Initialize test framework (Playwright/Cypress) | QA |
| `bmad-testarch-nfr` | Assess NFRs (performance, security, reliability) | QA |
| `bmad-testarch-test-design` | Create system/epic-level test plans | QA |
| `bmad-testarch-test-review` | Review test quality with best practices | QA |
| `bmad-testarch-trace` | Generate traceability matrix | QA |

#### Phase H — Documentation & Meta
| Skill | Description | Agent |
|-------|-------------|-------|
| `bmad-document-project` | Document brownfield projects for AI context | Tech Writer |
| `bmad-generate-project-context` | Create project-context.md with AI rules | Tech Writer |
| `bmad-index-docs` | Generate/update index.md for docs folder | Tech Writer |
| `bmad-shard-doc` | Split large markdown into organized files | Tech Writer |
| `bmad-distillator` | Lossless LLM-optimized compression of docs | Any |
| `bmad-editorial-review-prose` | Clinical copy-editing for text | Tech Writer |
| `bmad-editorial-review-structure` | Structural editing for docs | Tech Writer |

#### Phase I — Coordination & Meta
| Skill | Description | Agent |
|-------|-------------|-------|
| `bmad-correct-course` | Manage significant changes during sprint | SM |
| `bmad-retrospective` | Post-epic lessons learned | SM |
| `bmad-help` | Recommend next workflow or agent | Any |
| `bmad-party-mode` | Multi-agent group discussion | All |
| `bmad-teach-me-testing` | Teach testing progressively | QA |
| `bmad-agent-builder` | Build/edit/validate agent skills | Meta |
| `bmad-workflow-builder` | Build/modify workflows and skills | Meta |

### 3.3 Skill → Paperclip Agent Mapping (Recommended Org Chart)

```
CEO (Copilot SDK via process adapter)
 ├── PM (bmad-pm)
 │    Skills: bmad-brainstorming, bmad-market-research, bmad-create-product-brief,
 │            bmad-create-prd, bmad-edit-prd, bmad-validate-prd,
 │            bmad-create-epics-and-stories, bmad-create-story,
 │            bmad-check-implementation-readiness, bmad-correct-course
 │    ├── Developer (bmad-dev)
 │    │    Skills: bmad-dev-story, bmad-quick-dev, bmad-quick-spec
 │    └── Scrum Master (bmad-sm)
 │         Skills: bmad-sprint-planning, bmad-sprint-status, bmad-retrospective
 │
 ├── Architect (bmad-architect)
 │    Skills: bmad-create-architecture, bmad-technical-research, bmad-domain-research
 │    └── QA Engineer (bmad-qa)
 │         Skills: bmad-code-review, bmad-review-adversarial-general,
 │                 bmad-review-edge-case-hunter, bmad-qa-generate-e2e-tests,
 │                 bmad-testarch-*
 │
 ├── UX Designer (bmad-ux-designer)
 │    Skills: bmad-create-ux-design
 │
 ├── Analyst (bmad-analyst)
 │    Skills: bmad-domain-research, bmad-market-research, bmad-brainstorming
 │
 └── Tech Writer (bmad-tech-writer)
      Skills: bmad-document-project, bmad-generate-project-context,
              bmad-editorial-review-prose, bmad-editorial-review-structure
```

---

## 4. CEO Agent ↔ GitHub Copilot Integration

### 4.1 Why Process Adapter + Copilot SDK

The CEO doesn't need `claude_local` or `codex_local` (which require API keys you don't have). Instead:

1. **Process adapter** (`process`) spawns your TypeScript entrypoint
2. **Copilot SDK** (`@github/copilot-sdk`) connects to GitHub Copilot via `gh auth`
3. **No API keys needed** — Copilot SDK uses your existing GitHub authentication
4. Every agent (CEO, PM, Dev, etc.) runs through the same Copilot SDK process

### 4.2 Architecture

```
Paperclip (localhost:3100)
  │
  │  Heartbeat trigger (schedule/assignment/manual)
  │
  ├── CEO Agent (process adapter)
  │    command: "npx tsx src/heartbeat-entrypoint.ts"
  │    env: PAPERCLIP_* vars auto-injected
  │    │
  │    └── src/heartbeat-entrypoint.ts
  │         1. Read PAPERCLIP_AGENT_ID, PAPERCLIP_TASK_ID
  │         2. GET /api/agents/me → determine BMAD role
  │         3. GET /api/agents/me/inbox-lite → get assigned issues
  │         4. POST /api/issues/{id}/checkout
  │         5. Create Copilot SDK session (CopilotClient)
  │         6. Load BMAD agent persona + skills
  │         7. Send task prompt → LLM generates plan/code/etc.
  │         8. PATCH /api/issues/{id} with results
  │         9. POST /api/companies/{id}/issues for subtasks
  │
  ├── PM Agent (process adapter, same entrypoint, different agent ID)
  ├── Developer Agent (process adapter)
  ├── QA Agent (process adapter)
  └── ... all agents use the same process adapter pattern
```

### 4.3 CEO Prompt Template (for Paperclip `adapterConfig.promptTemplate`)

The CEO's `promptTemplate` should be strategic and delegation-focused:

```markdown
You are the CEO of an autonomous software company. You run inside Paperclip.

## Your Mission
Review company health, understand the current goal, and break it down into
delegatable work for your team. You DO NOT write code yourself.

## Your Team
- PM (bmad-pm): Product requirements, user stories, epics
- Architect (bmad-architect): Technical architecture, tech research
- Developer (bmad-dev): Code implementation
- QA (bmad-qa): Code review, quality gates
- UX Designer (bmad-ux-designer): UX patterns and design
- Analyst (bmad-analyst): Market & domain research
- Scrum Master (bmad-sm): Sprint planning & status
- Tech Writer (bmad-tech-writer): Documentation

## Heartbeat Protocol
Follow the Paperclip heartbeat protocol (Steps 1-9). On each wake:
1. Check your inbox for assigned issues
2. For new top-level issues, break them into a phased plan:
   a. Research phase: Create subtasks for brainstorming, market/tech research
   b. Definition phase: Create subtasks for PRD, architecture, UX design
   c. Planning phase: Create subtasks for epics & stories
   d. Execution phase: Stories are implemented and reviewed
3. Assign subtasks to the appropriate agents
4. Monitor progress and unblock as needed
```

### 4.4 Key Implementation: `src/heartbeat-entrypoint.ts`

This is the **new file to create** — a universal heartbeat handler that all Paperclip agents use:

```typescript
// Pseudocode — actual implementation in roadmap Phase 1
import { CopilotClient } from "@github/copilot-sdk";

// 1. Read Paperclip env vars
const agentId = process.env.PAPERCLIP_AGENT_ID;
const apiUrl = process.env.PAPERCLIP_API_URL;
const apiKey = process.env.PAPERCLIP_API_KEY;

// 2. Get agent identity → map to BMAD role
const me = await fetch(`${apiUrl}/api/agents/me`, { headers: { Authorization: `Bearer ${apiKey}` } });
const bmadRole = mapPaperclipRoleToBmad(me.role); // "ceo" → CEO logic, "engineer" → bmad-dev, etc.

// 3. Get assignments
const inbox = await fetch(`${apiUrl}/api/agents/me/inbox-lite`, ...);

// 4. For each task: checkout → load agent persona → create Copilot session → do work → update
for (const task of inbox.items) {
  await checkout(task.id);
  const session = await copilotClient.createSession({ agent: getAgent(bmadRole), skills, tools });
  const result = await session.send(buildPrompt(task));
  await updateIssue(task.id, result);
}
```

---

## 5. Agent MD File Configuration in Paperclip

### 5.1 The 4-File Agent Configuration Pattern

Paperclip uses a **4-file pattern** per agent, as seen in the official `paperclipai/companies` repo (`default/ceo/`):

```
<agent-home>/
├── AGENTS.md       ← Entry point: identity, memory references, safety rules
├── SOUL.md         ← Persona: strategic posture, voice & tone, values
├── HEARTBEAT.md    ← Heartbeat checklist: step-by-step execution protocol
└── TOOLS.md        ← Tool inventory: what tools the agent has access to
```

Each file serves a distinct purpose:

| File | Purpose | Loaded When |
|------|---------|-------------|
| **AGENTS.md** | Entry point. Identity, `$AGENT_HOME` reference, memory system pointers, safety rules. References the other 3 files. | Always (set as `instructionsFilePath`) |
| **SOUL.md** | Persona definition. Strategic posture, communication style, voice & tone, values. The "who you are". | Referenced from AGENTS.md, read at start of heartbeat |
| **HEARTBEAT.md** | Execution checklist. Step-by-step heartbeat protocol customized for this role. The "what to do every wake". | Read every heartbeat |
| **TOOLS.md** | Tool inventory. Initially empty, agents document tools as they learn to use them. | Read on demand |

**Yes, you need all 4 files for every agent.** The CEO's default config proves this is the standard pattern. Each agent's HEARTBEAT.md will differ (CEO delegates, Developer codes, QA reviews) but the structure is the same.

### 5.2 `$AGENT_HOME` — How Paperclip Resolves It

Paperclip automatically creates a home directory for each agent:

```
$PAPERCLIP_INSTANCE_ROOT/workspaces/<agent-id>/
```

For local development this resolves to something like:
```
~/.paperclip/workspaces/abc-123-uuid/
```

The `$AGENT_HOME` env var is injected into every heartbeat run by the adapter. The AGENTS.md says:
> Your home directory is `$AGENT_HOME`. Everything personal to you — life, memory, knowledge — lives there.

**For `claude_local` / `codex_local` adapters:** The adapter reads `adapterConfig.instructionsFilePath` and injects AGENTS.md as a system prompt via `--append-system-prompt-file`. Relative paths resolve against `adapterConfig.cwd`.

**For `process` adapter (our case):** We must read these files ourselves in our `heartbeat-entrypoint.ts` and inject them into the Copilot SDK session context.

### 5.3 How to Configure `instructionsFilePath` via API

```bash
# Set AGENTS.md as the instructions file for an agent
PATCH /api/agents/{agentId}/instructions-path
{
  "path": "AGENTS.md"
}
# Resolves relative to agent's adapterConfig.cwd (or $AGENT_HOME)
```

Alternatively, set it in the adapter config during agent creation:
```json
{
  "adapterType": "claude_local",
  "adapterConfig": {
    "cwd": "/path/to/project",
    "instructionsFilePath": "agents/ceo/AGENTS.md"
  }
}
```

### 5.4 Recommended Directory Structure for BMAD Agents

Since we're using the `process` adapter with a single entrypoint, we'll store the 4-file sets in the BMAD project and either:
- (a) Copy them into each agent's `$AGENT_HOME` on setup, or
- (b) Reference them directly from our entrypoint by reading the agent's role config

```
agents/
├── ceo/
│   ├── AGENTS.md
│   ├── SOUL.md
│   ├── HEARTBEAT.md
│   └── TOOLS.md
├── pm/
│   ├── AGENTS.md
│   ├── SOUL.md
│   ├── HEARTBEAT.md
│   └── TOOLS.md
├── architect/
│   ├── AGENTS.md
│   ├── SOUL.md
│   ├── HEARTBEAT.md
│   └── TOOLS.md
├── developer/
│   ├── AGENTS.md
│   ├── SOUL.md
│   ├── HEARTBEAT.md
│   └── TOOLS.md
├── qa/
│   ├── AGENTS.md
│   ├── SOUL.md
│   ├── HEARTBEAT.md
│   └── TOOLS.md
├── scrum-master/
│   ├── AGENTS.md
│   ├── SOUL.md
│   ├── HEARTBEAT.md
│   └── TOOLS.md
├── analyst/
│   ├── AGENTS.md
│   ├── SOUL.md
│   ├── HEARTBEAT.md
│   └── TOOLS.md
├── ux-designer/
│   ├── AGENTS.md
│   ├── SOUL.md
│   ├── HEARTBEAT.md
│   └── TOOLS.md
└── tech-writer/
    ├── AGENTS.md
    ├── SOUL.md
    ├── HEARTBEAT.md
    └── TOOLS.md
```

### 5.5 What Goes in Each File (Per Role)

#### AGENTS.md (Entry Point — Same Structure for All)

```markdown
You are the [ROLE TITLE].

Your home directory is $AGENT_HOME. Everything personal to you
— life, memory, knowledge — lives there.

Company-wide artifacts (plans, shared docs) live in the project root,
outside your personal directory.

## Memory and Planning

You MUST use the `para-memory-files` skill for all memory operations:
storing facts, writing daily notes, creating entities, running weekly
synthesis, recalling past context, and managing plans.

## Safety Considerations

- Never exfiltrate secrets or private data.
- Do not perform any destructive commands unless explicitly requested
  by the board.

## References

These files are essential. Read them.

- `$AGENT_HOME/HEARTBEAT.md` — execution checklist. Run every heartbeat.
- `$AGENT_HOME/SOUL.md` — who you are and how you should act.
- `$AGENT_HOME/TOOLS.md` — tools you have access to.
```

#### SOUL.md (Persona — Unique Per Role)

For BMAD agents, pull persona content from existing `src/agents/*.ts` files. Example for Developer:

```markdown
# SOUL.md — Developer Persona

You are a senior developer specializing in TypeScript.

## Strategic Posture
- Ship clean, tested, production-ready code.
- dev-story runs exactly ONCE per story — get it right.
- Follow BMAD coding standards: JSDoc on exports, strict types, error boundaries.
- When stuck, escalate to your manager — don't spin.

## Voice and Tone
- Technical and precise. Lead with what you did, then why.
- Use code blocks for any file references or commands.
- Keep comments concise: status line + bullets + links.
```

#### HEARTBEAT.md (Execution Protocol — Unique Per Role)

CEO heartbeat focuses on **delegation and monitoring**:
```markdown
# HEARTBEAT.md — CEO Heartbeat Checklist

## 1. Identity and Context
- GET /api/agents/me — confirm id, role, budget, chainOfCommand
- Check: PAPERCLIP_TASK_ID, PAPERCLIP_WAKE_REASON

## 2. Local Planning Check
1. Read today's plan from $AGENT_HOME/memory/YYYY-MM-DD.md
2. Review planned items: completed, blocked, next up
3. Record progress updates

## 3. Get Assignments
- GET /api/agents/me/inbox-lite
- Prioritize: in_progress > todo > blocked

## 4. Checkout and Work
- POST /api/issues/{id}/checkout before working
- For new top-level issues, break into phased subtasks:
  a. Research: brainstorming + market/tech research → assign PM, Analyst
  b. Definition: PRD + architecture → assign PM, Architect
  c. Planning: epics & stories → assign PM
  d. Execution: stories auto-flow Developer → QA

## 5. Delegation
- POST /api/companies/{id}/issues — always set parentId + goalId
- Assign subtasks to the right agent for the job

## 6. Exit
- Comment on in_progress work before exiting
```

Developer heartbeat focuses on **implementation**:
```markdown
# HEARTBEAT.md — Developer Heartbeat Checklist

## 1. Identity and Context
- GET /api/agents/me

## 2. Get Assignments
- GET /api/agents/me/inbox-lite
- Prioritize in_progress first

## 3. Checkout and Work
- POST /api/issues/{id}/checkout
- Read issue description + parent context
- Use bmad-dev-story skill to implement the story
- Write tests alongside production code
- Run tests to verify

## 4. Update and Exit
- PATCH /api/issues/{id} → status: in_review
- Post comment: what was implemented, files changed, test results
```

#### TOOLS.md (Tool Inventory)

Starts mostly empty, then each agent documents tools as they use them:

```markdown
# Tools

## Paperclip API
- Issue management (checkout, update, comment, create subtasks)
- Agent identity and inbox

## BMAD Skills
- bmad-dev-story — Story implementation
- bmad-quick-dev — Quick implementations

## Copilot SDK Tools
- create_story — Create story files
- dev_story — Implement stories
- sprint_status — Read/update sprint status

(Add notes about tools as you acquire and use them.)
```

### 5.6 PARA Memory System (Optional but Recommended)

The default CEO config uses the `para-memory-files` skill for persistent memory across heartbeats. This creates:

```
$AGENT_HOME/
├── life/                    # PARA knowledge graph
│   ├── projects/            # Active work with goals/deadlines
│   ├── areas/               # Ongoing responsibilities
│   ├── resources/           # Reference material
│   └── archives/            # Inactive items
├── memory/                  # Daily notes
│   └── YYYY-MM-DD.md       # Timeline entries per day
└── MEMORY.md                # Tacit knowledge (patterns, preferences)
```

This is powerful for multi-heartbeat context retention. The CEO's HEARTBEAT.md includes a "Fact Extraction" step that saves durable facts after each heartbeat. **Consider enabling this for all agents** — it lets them learn and remember across sessions.

### 5.7 How Skills Fit Into the Picture

Skills are the **"how to do the work"** — they are the procedural knowledge that agents invoke during Step 7 ("Do the work") of the heartbeat protocol. The 4 agent files define *who the agent is* and *what it does each heartbeat*; skills define *how it does the actual domain work*.

#### The Full Mental Model

```
┌─────────────────────────────────────────────────────────────────┐
│  AGENT IDENTITY (4-file set in $AGENT_HOME)                     │
│                                                                  │
│  AGENTS.md  ← "You are the PM. Here's your memory system."      │
│  SOUL.md    ← "You think strategically, speak directly."        │
│  HEARTBEAT.md ← "Each wake: check inbox → checkout → work →    │
│                  update → exit"                                  │
│  TOOLS.md   ← "You have these tools available."                 │
│                                                                  │
│  These define WHO you are and WHEN to act.                      │
├─────────────────────────────────────────────────────────────────┤
│  PAPERCLIP SKILLS (coordination layer)                           │
│                                                                  │
│  paperclip/SKILL.md          ← Heartbeat protocol, API calls,   │
│                                 checkout, comments, delegation   │
│  paperclip-create-agent/     ← How to hire new agents            │
│  para-memory-files/          ← PARA memory system operations     │
│                                                                  │
│  These define HOW to coordinate with Paperclip.                 │
├─────────────────────────────────────────────────────────────────┤
│  BMAD SKILLS (domain work layer)                                 │
│                                                                  │
│  bmad-create-prd/            ← 12-step PRD creation workflow     │
│  bmad-create-architecture/   ← Architecture design workflow      │
│  bmad-dev-story/             ← Story implementation workflow     │
│  bmad-code-review/           ← Adversarial code review           │
│  bmad-brainstorming/         ← Creative ideation techniques      │
│  ... (56 skills total)                                           │
│                                                                  │
│  These define HOW to do the actual software building work.      │
└─────────────────────────────────────────────────────────────────┘
```

#### Two Skill Systems (Paperclip vs BMAD)

There are **two separate skill systems** that need to coexist:

| System | Skills | Format | Purpose |
|--------|--------|--------|---------|
| **Paperclip skills** | `paperclip`, `paperclip-create-agent`, `para-memory-files` | `SKILL.md` + `references/` | Coordination: API calls, heartbeat protocol, memory, hiring |
| **BMAD skills** | 56 skills (`bmad-create-prd`, `bmad-dev-story`, etc.) | `SKILL.md` → `workflow.md` + `steps/` + `templates/` + `data/` | Domain work: PRDs, architecture, code, reviews |

Both follow the same **skill format** (directory with `SKILL.md` entry point), which means they're compatible — both can be loaded by any adapter that supports skills.

#### How Skills Are Loaded (By Adapter Type)

**`claude_local` adapter** (for reference):
```
1. Builds a temp dir with .claude/skills/ containing symlinks to Paperclip skills
2. Passes --add-dir <tmpdir> to Claude Code CLI
3. Claude Code discovers skills and makes them invokable via "use the X skill"
4. AGENTS.md is injected via --append-system-prompt-file
```

**`codex_local` adapter** (for reference):
```
1. Symlinks Paperclip skills into ~/.codex/skills/ (global Codex skills dir)
2. Codex CLI discovers them as registered skills
3. AGENTS.md is injected via instructionsFilePath
```

**`process` adapter (our case — Copilot SDK)**:
```
1. Our heartbeat-entrypoint.ts reads AGENTS.md + SOUL.md + HEARTBEAT.md
2. Injects them as system prompt into the Copilot SDK session
3. BMAD skills are loaded via Copilot SDK's skillDirectories option
4. Paperclip skills (heartbeat protocol) are either:
   a. Embedded in HEARTBEAT.md (the heartbeat checklist IS the protocol), or
   b. Loaded as additional skill directories
```

#### How an Agent Invokes a Skill (Runtime Flow)

When a PM agent wakes up and has an issue "Create PRD for todo app":

```
1. AGENTS.md loaded → "You are the PM"
2. SOUL.md loaded → persona/voice
3. HEARTBEAT.md followed → checkout issue, understand context
4. Step 7 "Do the work" → PM sees the issue is about creating a PRD
5. PM invokes bmad-create-prd skill:
   a. SKILL.md says "Follow the instructions in ./workflow.md"
   b. workflow.md defines a 12-step discovery process
   c. Each step references files in steps-c/ and templates/
   d. Output: a PRD document written to the project
6. HEARTBEAT.md continues → update issue status, post comment with results
```

#### Skill Assignment Per Agent

Not all agents need all skills. Each agent should only have access to skills relevant to their role:

| Agent | Paperclip Skills | BMAD Skills |
|-------|-----------------|-------------|
| **CEO** | `paperclip`, `paperclip-create-agent`, `para-memory-files` | `bmad-help` (for guidance only — CEO doesn't do domain work) |
| **PM** | `paperclip`, `para-memory-files` | `bmad-brainstorming`, `bmad-market-research`, `bmad-create-product-brief`, `bmad-create-prd`, `bmad-edit-prd`, `bmad-validate-prd`, `bmad-create-epics-and-stories`, `bmad-create-story`, `bmad-check-implementation-readiness` |
| **Architect** | `paperclip`, `para-memory-files` | `bmad-create-architecture`, `bmad-technical-research`, `bmad-domain-research` |
| **Developer** | `paperclip`, `para-memory-files` | `bmad-dev-story`, `bmad-quick-dev`, `bmad-quick-spec` |
| **QA** | `paperclip`, `para-memory-files` | `bmad-code-review`, `bmad-review-adversarial-general`, `bmad-review-edge-case-hunter`, `bmad-qa-generate-e2e-tests`, `bmad-testarch-*` |
| **Scrum Master** | `paperclip`, `para-memory-files` | `bmad-sprint-planning`, `bmad-sprint-status`, `bmad-correct-course`, `bmad-retrospective` |
| **Analyst** | `paperclip`, `para-memory-files` | `bmad-brainstorming`, `bmad-market-research`, `bmad-domain-research`, `bmad-advanced-elicitation` |
| **UX Designer** | `paperclip`, `para-memory-files` | `bmad-create-ux-design` |
| **Tech Writer** | `paperclip`, `para-memory-files` | `bmad-document-project`, `bmad-generate-project-context`, `bmad-editorial-review-prose`, `bmad-editorial-review-structure` |

#### Where to Reference Skills

Skills are referenced in **two places** in the 4-file set:

1. **TOOLS.md** — Lists available skills with descriptions:
   ```markdown
   # Tools

   ## Paperclip Skills
   - `paperclip` — Heartbeat coordination, API calls, checkout, comments
   - `para-memory-files` — PARA memory: facts, daily notes, knowledge graph

   ## BMAD Skills
   - `bmad-dev-story` — Execute story implementation from spec file
   - `bmad-quick-dev` — Implement quick changes
   ```

2. **HEARTBEAT.md** — References skills in the "Do the work" step:
   ```markdown
   ## 5. Do the Work
   - For story implementation: invoke `bmad-dev-story` skill
   - For quick fixes: invoke `bmad-quick-dev` skill
   - Always use the `paperclip` skill for API coordination
   ```

#### Implementation: Skill Loading for Process Adapter

Since we use the `process` adapter, we need to load both skill systems ourselves:

```typescript
// In heartbeat-entrypoint.ts

// 1. BMAD skills — loaded via Copilot SDK skillDirectories
const bmadSkillsDir = "/Users/Q543651/repos/AI Repo/BMAD_Copilot_RT/skills";

// 2. Paperclip skills — loaded from Paperclip's skills/ directory
const paperclipSkillsDir = "/Users/Q543651/repos/AI Repo/paperclip/skills";

// 3. Filter to only skills relevant to this agent's role
const agentSkills = getSkillsForRole(role); // e.g., ["bmad-dev-story", "bmad-quick-dev"]

// 4. Create Copilot SDK session with both skill sets
const session = await client.createSession({
  skillDirectories: [
    bmadSkillsDir,      // All BMAD skills (SDK filters by invocation)
    paperclipSkillsDir, // Paperclip coordination skills
  ],
  // Agent identity injected as system prompt
  systemMessage: [
    agentsContent,    // AGENTS.md
    soulContent,      // SOUL.md
    heartbeatContent, // HEARTBEAT.md
    toolsContent,     // TOOLS.md
  ].join("\n\n"),
});
```

Alternatively, for tighter control, only symlink the skills each agent needs:

```typescript
// Create a temp dir with only this agent's skills
const tmpSkillsDir = await mkdtemp("agent-skills-");
for (const skillName of agentSkills) {
  await symlink(`${bmadSkillsDir}/${skillName}`, `${tmpSkillsDir}/${skillName}`);
}
// + always include paperclip skills
await symlink(`${paperclipSkillsDir}/paperclip`, `${tmpSkillsDir}/paperclip`);
await symlink(`${paperclipSkillsDir}/para-memory-files`, `${tmpSkillsDir}/para-memory-files`);
```

---

## 6. Implementation Roadmap

### Phase 1: Create Universal Heartbeat Entrypoint (HIGH PRIORITY)
**Goal:** Single TypeScript entrypoint that all Paperclip agents use to run via the process adapter.

**Tasks:**
- [ ] Create `src/heartbeat-entrypoint.ts` — reads `PAPERCLIP_*` env vars, maps agent ID → BMAD role, follows heartbeat protocol, dispatches via Copilot SDK
- [ ] Create role-mapping config: `{ "ceo": { bmadAgent: null, skills: [...], isOrchestrator: true }, "engineer": { bmadAgent: "bmad-dev", skills: ["bmad-dev-story"], ... } }`
- [ ] Wire into existing `SessionManager` and `AgentDispatcher`
- [ ] Test locally: `PAPERCLIP_AGENT_ID=test PAPERCLIP_API_URL=http://localhost:3100 npx tsx src/heartbeat-entrypoint.ts`

**Files to create/modify:**
- `src/heartbeat-entrypoint.ts` (NEW)
- `src/config/role-mapping.ts` (NEW)
- `src/adapter/heartbeat-handler.ts` (extend for CEO orchestration logic)

### Phase 2: Create Agent 4-File Configuration Sets
**Goal:** Full AGENTS.md + SOUL.md + HEARTBEAT.md + TOOLS.md per Paperclip role, following the official `paperclipai/companies` pattern.

**Tasks:**
- [ ] Create `agents/` directory with 4-file set for each role (see Section 5.4)
- [ ] **AGENTS.md** — Entry point with identity, memory references, safety rules (same structure, role-specific intro)
- [ ] **SOUL.md** — Extract persona content from `src/agents/*.ts` into persona format (strategic posture + voice & tone)
- [ ] **HEARTBEAT.md** — Write role-specific heartbeat checklists (CEO delegates, Dev codes, QA reviews, PM researches)
- [ ] **TOOLS.md** — Document available BMAD skills and Copilot SDK tools per role
- [ ] Add CEO-specific orchestration workflow in heartbeat (phased delegation: research → define → plan → execute)
- [ ] Create setup script to copy/symlink agent files into `$AGENT_HOME` on agent creation

**Files to create (4 × 9 agents = 36 files):**
- `agents/ceo/{AGENTS,SOUL,HEARTBEAT,TOOLS}.md`
- `agents/pm/{AGENTS,SOUL,HEARTBEAT,TOOLS}.md`
- `agents/architect/{AGENTS,SOUL,HEARTBEAT,TOOLS}.md`
- `agents/developer/{AGENTS,SOUL,HEARTBEAT,TOOLS}.md`
- `agents/qa/{AGENTS,SOUL,HEARTBEAT,TOOLS}.md`
- `agents/ux-designer/{AGENTS,SOUL,HEARTBEAT,TOOLS}.md`
- `agents/analyst/{AGENTS,SOUL,HEARTBEAT,TOOLS}.md`
- `agents/scrum-master/{AGENTS,SOUL,HEARTBEAT,TOOLS}.md`
- `agents/tech-writer/{AGENTS,SOUL,HEARTBEAT,TOOLS}.md`

### Phase 3: Configure Paperclip Company & Agents
**Goal:** Set up the Paperclip company with all agents using the process adapter.

**Tasks:**
- [ ] Ensure Paperclip is running: `docker compose up` or `pnpm dev` in Paperclip repo
- [ ] Create company via UI with goal
- [ ] Create CEO agent (process adapter, `npx tsx src/heartbeat-entrypoint.ts`)
- [ ] Create PM, Architect, Developer, QA, SM, Analyst, UX Designer, Tech Writer agents
- [ ] Set org chart (CEO → PM, Architect; PM → Developer, SM; Architect → QA)
- [ ] Set `instructionsFilePath` for each agent via `PATCH /api/agents/{id}/instructions-path`
- [ ] Set heartbeat intervals (CEO: 60s, others: 30s)
- [ ] Set budgets
- [ ] Alternatively: create a setup script `scripts/setup-paperclip-company.ts`

**Agent creation template (curl):**
```bash
curl -X POST "$PAPERCLIP_API_URL/api/companies/$COMPANY_ID/agents" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "bmad-pm",
    "role": "manager",
    "title": "Product Manager",
    "capabilities": "PRD creation, user stories, market research, requirements",
    "adapterType": "process",
    "adapterConfig": {
      "command": "npx tsx src/heartbeat-entrypoint.ts",
      "cwd": "/Users/Q543651/repos/AI Repo/BMAD_Copilot_RT",
      "timeoutSec": 600
    },
    "runtimeConfig": {
      "heartbeat": { "enabled": true, "intervalSec": 60, "wakeOnDemand": true }
    }
  }'
```

### Phase 4: CEO Orchestration Logic
**Goal:** Implement the CEO's strategic delegation — receiving a high-level issue and breaking it into the BMAD pipeline.

**Tasks:**
- [ ] Implement CEO-specific heartbeat handler that:
  - Reads top-level issues
  - Creates phased subtask plans (research → define → plan → execute)
  - Assigns subtasks to the right agents
  - Monitors progress across heartbeats
  - Handles governance (approval requests)
- [ ] Create issue templates for each phase (research task, PRD task, architecture task, etc.)
- [ ] Implement progress monitoring: CEO checks if research subtasks are done before creating definition subtasks
- [ ] Test full pipeline: create issue → CEO delegates → agents work → stories complete

**Files to create/modify:**
- `src/adapter/ceo-orchestrator.ts` (NEW — CEO-specific delegation logic)
- `src/adapter/heartbeat-entrypoint.ts` (wire CEO orchestrator)
- `src/adapter/heartbeat-handler.ts` (extend phase routing)

### Phase 5: Expand Agent Dispatcher with All BMAD Skills
**Goal:** Currently only 5 phases are mapped (create-story, dev-story, code-review, sprint-planning, sprint-status). Expand to cover all 56 BMAD skills.

**Tasks:**
- [ ] Add new WorkPhase types: `research`, `create-prd`, `create-architecture`, `create-ux-design`, `create-epics`, `e2e-tests`, `documentation`, etc.
- [ ] Map each phase to the correct agent + skills + tools in `getPhaseConfig()`
- [ ] Create Copilot SDK tool definitions for new skills (or use skills as prompt modules)
- [ ] Update `inferPhaseFromRole()` to handle expanded roles

**Files to modify:**
- `src/adapter/agent-dispatcher.ts` (expand phase routing)
- `src/tools/` (add tool definitions for new skills)

### Phase 6: End-to-End Testing
**Goal:** Validate the full autonomous pipeline from issue creation to story completion.

**Tasks:**
- [ ] Create test issue: "Build a simple REST API for a todo app"
- [ ] Verify CEO creates research subtasks
- [ ] Verify PM completes brainstorming/market research
- [ ] Verify Architect creates architecture doc
- [ ] Verify PM creates PRD and stories
- [ ] Verify Developer implements stories
- [ ] Verify QA reviews code
- [ ] Verify CEO monitors and unblocks
- [ ] Document results and iterate

### Phase 7: Production Hardening
**Goal:** Make the system robust for continuous autonomous operation.

**Tasks:**
- [ ] Add session persistence across heartbeats (Copilot SDK session IDs)
- [ ] Add error recovery (agent crashes, timeout handling)
- [ ] Add cost tracking (map Copilot SDK token usage to Paperclip budgets)
- [ ] Add stall detection for Paperclip issues (stuck in_progress)
- [ ] Switch to webhook mode (Paperclip pushes → HTTP endpoint on BMAD side)
- [ ] Add observability: trace heartbeats, log agent decisions, metrics on issue throughput

---

## Summary of Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| LLM Provider | GitHub Copilot via Copilot SDK | Already authenticated via `gh auth`, no API keys needed |
| Adapter Type | `process` | Spawns TypeScript process with Copilot SDK, no external LLM keys required |
| CEO Implementation | Copilot SDK session with strategic prompt | CEO can use LLM reasoning to plan, delegate, and monitor |
| Agent Instructions | AGENTS.md files per role | Standard Paperclip pattern, easy to version and iterate |
| Skills Injection | `skillDirectories` in Copilot SDK session config | BMAD skills loaded as prompt modules |
| Entrypoint | Single `heartbeat-entrypoint.ts` for all agents | Uniform process adapter config, role-specific behavior via BMAD agent mapping |

---

## Quick Start Commands

```bash
# 1. Start Paperclip
cd /Users/Q543651/repos/AI\ Repo/paperclip
pnpm dev

# 2. Create company + agents (after Phase 3 script)
cd /Users/Q543651/repos/AI\ Repo/BMAD_Copilot_RT
npx tsx scripts/setup-paperclip-company.ts

# 3. Create a test issue in Paperclip UI
# Title: "Build a REST API for a todo app"
# Assign to: CEO agent

# 4. Watch the magic happen
# CEO wakes → delegates research → PM researches → CEO reviews → PM creates PRD → ...
```
## More notes:

Update organization chart
