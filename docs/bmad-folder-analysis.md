# BMAD Folder Analysis — `_bmad/` and `skills/`

> Comprehensive audit of what we use, what we don't, and what's valuable.

## TL;DR

| Folder | Still needed? | Why |
|--------|:---:|------|
| `_bmad/` | **YES** | Runtime dependency — agent prompts, config, skill workflows, and the 4-file agent configs all reference `_bmad/` paths at runtime |
| `skills/` | **YES** | Runtime dependency — Copilot SDK loads skill directories as `skills/` for interactive VS Code usage; the 9 agent-launcher skills point back to `_bmad/bmm/agents/` |

---

## 1. What is `_bmad/`?

The `_bmad/` directory is the **BMAD Method v6.2.0** installation. It was installed by the BMAD installer and contains 4 modules:

| Module | Version | Source | Content |
|--------|---------|--------|---------|
| `core` | 6.2.0 | built-in | Universal skills (brainstorming, adversarial review, edge case hunting, distillator, party mode, etc.) |
| `bmm` | 6.2.0 | built-in | Agents (9 persona definitions), workflows (full SDLC lifecycle), teams, config |
| `bmb` | 1.1.0 | external | BMAD Builder — agent and workflow builder/optimizer tools |
| `tea` | 1.7.0 | external | Test Architecture Enterprise — 9 testarch workflows, 42 knowledge base articles |

### Structure

```
_bmad/
├── _config/             ← Manifests, agent customization YAML, IDE config
│   ├── manifest.yaml           (module registry)
│   ├── agent-manifest.csv      (9 agents: name, persona, capabilities, module path)
│   ├── skill-manifest.csv      (47 skills with canonical IDs, descriptions, paths)
│   ├── agents/                 (9 customize.yaml files — override persona/memories)
│   └── ides/github-copilot.yaml
├── _memory/             ← Persistent agent memory
│   ├── config.yaml             (user_name: Jay, language: English)
│   └── tech-writer-sidecar/    (documentation-standards.md)
├── bmm/                 ← BMAD Method Module (core methodology)
│   ├── agents/                 (9 agent .md files — full persona + activation XML)
│   ├── config.yaml             (project_name, paths, user config)
│   ├── data/                   (project-context-template.md)
│   ├── teams/                  (team-fullstack.yaml, default-party.csv)
│   └── workflows/
│       ├── 1-analysis/         (product brief, domain/market/technical research)
│       ├── 2-plan-workflows/   (create UX, edit PRD, validate PRD)
│       ├── 3-solutioning/      (create architecture, epics & stories, readiness check)
│       ├── 4-implementation/   (create-story, dev-story, code-review, sprint-planning, sprint-status, retrospective, correct-course)
│       ├── bmad-document-project/
│       ├── bmad-generate-project-context/
│       ├── bmad-qa-generate-e2e-tests/
│       └── bmad-quick-flow/    (quick-spec, quick-dev, quick-dev-new-preview)
├── core/                ← Universal skills & tasks
│   ├── skills/                 (11 skills: elicitation, brainstorming, distillator, editorial review prose/structure, help, index-docs, party-mode, adversarial-review, edge-case-hunter, shard-doc)
│   └── tasks/bmad-create-prd/
├── bmb/                 ← BMAD Builder
│   └── skills/                 (agent-builder, workflow-builder — with quality scanners & optimizer)
└── tea/                 ← Test Architecture Enterprise
    ├── agents/tea-agent-testarch/
    ├── testarch/knowledge/     (42 knowledge articles: fixtures, API patterns, CI, Pact, Playwright, etc.)
    └── workflows/testarch/     (9 workflows: ATDD, automate, CI, framework, NFR, test-design, test-review, trace, teach-me)
```

---

## 2. What is `skills/`?

The `skills/` directory contains **56 Copilot SDK skill directories**, each with a `SKILL.md` entry point. These are the skills that the Copilot SDK can invoke via `exec="skill:bmad-*"` references in agent menus.

There are **2 categories**:

### 2a. Agent-Launcher Skills (9)

These are thin wrappers that tell the LLM to load a full agent persona from `_bmad/bmm/agents/`:

```
skills/bmad-dev/SKILL.md        → loads _bmad/bmm/agents/dev.md
skills/bmad-pm/SKILL.md         → loads _bmad/bmm/agents/pm.md
skills/bmad-architect/SKILL.md  → loads _bmad/bmm/agents/architect.md
skills/bmad-qa/SKILL.md         → loads _bmad/bmm/agents/qa.md
skills/bmad-sm/SKILL.md         → loads _bmad/bmm/agents/sm.md
skills/bmad-analyst/SKILL.md    → loads _bmad/bmm/agents/analyst.md
skills/bmad-tech-writer/SKILL.md → loads _bmad/bmm/agents/tech-writer/
skills/bmad-ux-designer/SKILL.md → loads _bmad/bmm/agents/ux-designer.md
skills/bmad-quick-flow-solo-dev/SKILL.md → loads _bmad/bmm/agents/quick-flow-solo-dev.md
```

### 2b. Workflow/Skill Entry Points (47)

These are the actual skill prompts that point to `workflow.md` files deeper inside `_bmad/`:

| Skill | Source in `_bmad/` | Purpose |
|-------|--------------------|---------|
| `bmad-dev-story` | `bmm/workflows/4-implementation/bmad-dev-story/workflow.md` | Execute story implementation with TDD |
| `bmad-code-review` | `bmm/workflows/4-implementation/bmad-code-review/workflow.md` | 3-layer adversarial code review |
| `bmad-create-story` | `bmm/workflows/4-implementation/bmad-create-story/workflow.md` | Create story files from backlog |
| `bmad-sprint-status` | `bmm/workflows/4-implementation/bmad-sprint-status/workflow.md` | Sprint status and risk surfacing |
| `bmad-sprint-planning` | `bmm/workflows/4-implementation/bmad-sprint-planning/workflow.md` | Generate sprint from epics |
| `bmad-create-prd` | `core/tasks/bmad-create-prd/SKILL.md` | PRD creation |
| `bmad-create-architecture` | `bmm/workflows/3-solutioning/` | Architecture design |
| `bmad-create-epics-and-stories` | `bmm/workflows/3-solutioning/` | Break requirements into epics |
| `bmad-check-implementation-readiness` | `bmm/workflows/3-solutioning/` | Validate specs are complete |
| `bmad-party-mode` | `core/skills/bmad-party-mode/workflow.md` | Multi-agent group discussion |
| `bmad-brainstorming` | `core/skills/bmad-brainstorming/` | Facilitated brainstorming |
| `bmad-review-adversarial-general` | `core/skills/` | Cynical/adversarial review |
| `bmad-review-edge-case-hunter` | `core/skills/` | Exhaustive edge case analysis |
| `bmad-distillator` | `core/skills/` | Lossless document compression |
| `bmad-retrospective` | `bmm/workflows/4-implementation/` | Post-epic retrospective |
| `bmad-correct-course` | `bmm/workflows/4-implementation/` | Mid-sprint course correction |
| `bmad-quick-spec` | `bmm/workflows/bmad-quick-flow/` | Quick technical spec |
| `bmad-quick-dev` | `bmm/workflows/bmad-quick-flow/` | Quick implementation |
| `bmad-quick-dev-new-preview` | `bmm/workflows/bmad-quick-flow/` | Unified quick flow (preview) |
| `bmad-testarch-*` (9 skills) | `tea/workflows/testarch/` | Test architecture suite |
| ... and 18 more | Various | Research, UX, editorial, etc. |

---

## 3. How Our Implementation Uses These

### 3a. Direct References in Code

| Our File | What it uses from `_bmad/` |
|----------|---------------------------|
| `scripts/convert-bmad-agents.ts` | Reads `_bmad/_config/agent-manifest.csv` and `_bmad/bmm/agents/*.md` to auto-generate `src/agents/*.ts` |
| `src/agents/*.ts` (9 files) | **Contain the full BMAD agent persona prompts** copied from `_bmad/bmm/agents/`. These prompts reference `{project-root}/_bmad/bmm/config.yaml` at activation time (Step 2). They also reference skills via `exec="skill:bmad-*"`. |
| `agents/*/HEARTBEAT.md` (10 dirs) | Reference BMAD skills by name: `bmad-dev-story`, `bmad-quick-dev`, `bmad-quick-spec`, `bmad-code-review`, etc. |
| `agents/*/TOOLS.md` (10 dirs) | List BMAD skills available to each agent |
| `src/heartbeat-entrypoint.ts` | `loadAgentConfigFiles()` reads `agents/{role}/AGENTS.md`, `SOUL.md`, `HEARTBEAT.md`, `TOOLS.md` — these files reference skills and `_bmad/` paths |

### 3b. How Skills Are Invoked at Runtime

The chain is:
```
Paperclip heartbeat
  → heartbeat-entrypoint.ts (loads 4-file config)
  → SessionManager (creates Copilot SDK session with system message)
  → Agent prompt says "invoke bmad-dev-story skill"
  → Copilot SDK finds skills/bmad-dev-story/SKILL.md
  → SKILL.md says "follow ./workflow.md"
  → workflow.md references _bmad/bmm/config.yaml and step files
```

**This means `_bmad/` is a runtime dependency** — if an agent session invokes a skill, the LLM reads files from `_bmad/` at execution time.

### 3c. What Our TypeScript Code Implements (vs. what `_bmad/` provides as prompts)

| Feature | Our TypeScript Implementation | BMAD Prompt/Workflow |
|---------|------------------------------|---------------------|
| **Story lifecycle** (backlog→done) | `src/adapter/sprint-runner.ts`, `src/tools/sprint-status.ts` | `bmad-sprint-status`, `bmad-sprint-planning` workflows |
| **Story creation** | `src/tools/create-story.ts` | `bmad-create-story` workflow (template.md, discover-inputs.md, checklist.md) |
| **Story development** | `src/tools/dev-story.ts` | `bmad-dev-story` workflow (451-line workflow.md with 6 steps) |
| **Code review** | `src/quality-gates/engine.ts`, `review-orchestrator.ts` | `bmad-code-review` workflow (4-step: gather→review→triage→present) using 3 parallel reviewers |
| **Agent routing** | `src/adapter/agent-dispatcher.ts` | Agent manifest CSV + role mapping |
| **Sprint status** | `src/tools/sprint-status.ts` | `bmad-sprint-status` workflow |

**Key insight**: Our TypeScript tools (`src/tools/`) provide the **programmatic orchestration** (lifecycle state machine, quality gate scoring, model routing). The BMAD skills in `_bmad/` provide the **LLM prompt instructions** that tell the agent *how* to think and act when executing those tools. **Both layers are needed** — they serve complementary roles.

---

## 4. Do We Still Need Both Folders?

### `_bmad/` — **YES, REQUIRED**

| Reason | Detail |
|--------|--------|
| **Agent prompts reference it** | Every agent's activation Step 2 loads `_bmad/bmm/config.yaml` |
| **Skills read workflow files from it** | The 47 workflow skills point to `workflow.md` files inside `_bmad/` |
| **Tech-writer uses memory sidecar** | `_bmad/_memory/tech-writer-sidecar/documentation-standards.md` |
| **convert-bmad-agents.ts needs it** | Script reads `_bmad/_config/agent-manifest.csv` and agent `.md` files |
| **Config values** | `project_name`, `user_name`, `output_folder`, artifact paths, etc. |

### `skills/` — **YES, REQUIRED**

| Reason | Detail |
|--------|--------|
| **Copilot SDK skill resolution** | When an agent prompt says `exec="skill:bmad-dev-story"`, the SDK looks for `skills/bmad-dev-story/SKILL.md` |
| **Agent-launcher skills** | The 9 agent skills load full personas for interactive VS Code usage |
| **Independent of `_bmad/`** | `skills/` is the *entry point index* that the SDK resolves; `_bmad/` is the *implementation* the entry points delegate to |

### Could they be consolidated?

Not easily — they serve different architectural roles:
- `_bmad/` = BMAD Method installation (upstream, versioned, module-based)
- `skills/` = Copilot SDK skill registry (what the SDK can resolve)
- `agents/` = Paperclip 4-file configs (heartbeat-specific system prompts)
- `src/agents/` = TypeScript agent definitions with embedded persona prompts

---

## 5. Feature Coverage Matrix

### ✅ IMPLEMENTED — Reflected in our code

| BMAD Feature | `_bmad/` Source | Our Implementation |
|-------------|-----------------|-------------------|
| 9 agent personas | `bmm/agents/*.md` | `src/agents/*.ts` (auto-generated by `convert-bmad-agents.ts`) |
| Agent manifest | `_config/agent-manifest.csv` | Read by `convert-bmad-agents.ts` |
| Agent customization | `_config/agents/*.customize.yaml` | Templates exist, unused in code (manual customization point) |
| Dev-story workflow | `bmm/workflows/4-implementation/bmad-dev-story/` | `src/tools/dev-story.ts` + skill prompt |
| Code review (adversarial) | `bmm/workflows/4-implementation/bmad-code-review/` | `src/quality-gates/` (engine, review-orchestrator, types) |
| Story creation | `bmm/workflows/4-implementation/bmad-create-story/` | `src/tools/create-story.ts` + skill prompt |
| Sprint status | `bmm/workflows/4-implementation/bmad-sprint-status/` | `src/tools/sprint-status.ts` + MCP server |
| Sprint planning | `bmm/workflows/4-implementation/bmad-sprint-planning/` | `src/tools/sprint-status.ts` (partial) |
| Quality gate scoring | `core/skills/bmad-review-adversarial-general/` | `src/quality-gates/engine.ts` (severity weights, blocking logic) |
| Edge case hunting | `core/skills/bmad-review-edge-case-hunter/` | Referenced in code-review workflow (parallel reviewer layer) |
| Project config | `bmm/config.yaml`, `_memory/config.yaml` | Agent prompts reference at activation |
| 4-file agent configs | — | `agents/*/AGENTS.md`, `SOUL.md`, `HEARTBEAT.md`, `TOOLS.md` |
| Documentation standards | `_memory/tech-writer-sidecar/` | Referenced in tech-writer agent prompts |

### ⚠️ PARTIALLY IMPLEMENTED

| BMAD Feature | `_bmad/` Source | Status |
|-------------|-----------------|--------|
| Party mode (multi-agent discussion) | `core/skills/bmad-party-mode/` | Referenced in agent menus (`exec="skill:bmad-party-mode"`) but never triggered by our orchestration pipeline |
| Retrospective | `bmm/workflows/4-implementation/bmad-retrospective/` | Skill exists, SM agent menu references it, but not wired into automated sprint cycle |
| Course correction | `bmm/workflows/4-implementation/bmad-correct-course/` | PM agent menu references it, not automated |

### ❌ NOT IMPLEMENTED — Unused features

| BMAD Feature | `_bmad/` Source | Potential Value |
|-------------|-----------------|----------------|
| **Product brief creation** | `bmm/workflows/1-analysis/bmad-create-product-brief/` | Structured discovery for new projects |
| **PRD creation/validation/editing** | `core/tasks/bmad-create-prd/`, `bmm/workflows/2-plan-workflows/` | Full PRD lifecycle with validation |
| **Architecture creation** | `bmm/workflows/3-solutioning/bmad-create-architecture/` | Guided architecture design |
| **Epics & stories generation** | `bmm/workflows/3-solutioning/bmad-create-epics-and-stories/` | Break requirements into development units |
| **Implementation readiness check** | `bmm/workflows/3-solutioning/bmad-check-implementation-readiness/` | Pre-dev quality gate |
| **UX design creation** | `bmm/workflows/2-plan-workflows/bmad-create-ux-design/` | Structured UX spec generation |
| **Domain/market/technical research** | `bmm/workflows/1-analysis/research/` | Three specialized research workflows |
| **Document distillation** | `core/skills/bmad-distillator/` | Lossless LLM-optimized compression |
| **Document sharding** | `core/skills/bmad-shard-doc/` | Split large docs into organized files |
| **Advanced elicitation** | `core/skills/bmad-advanced-elicitation/` | Push LLM to refine/improve output |
| **Brainstorming** | `core/skills/bmad-brainstorming/` | Facilitated ideation sessions |
| **Editorial review (prose + structure)** | `core/skills/bmad-editorial-review-*` | Professional copy-editing and structural review |
| **Index docs** | `core/skills/bmad-index-docs/` | Generate index.md for folders |
| **Project documentation** | `bmm/workflows/bmad-document-project/` | Brownfield project documentation |
| **Project context generation** | `bmm/workflows/bmad-generate-project-context/` | Create project-context.md for AI agents |
| **QA E2E test generation** | `bmm/workflows/bmad-qa-generate-e2e-tests/` | Generate E2E tests from features |
| **Quick flow (spec + dev)** | `bmm/workflows/bmad-quick-flow/` | Lean workflow for small changes |
| **Agent builder/optimizer** | `bmb/skills/bmad-agent-builder/` | Build and optimize BMAD agents |
| **Workflow builder** | `bmb/skills/bmad-workflow-builder/` | Build and validate BMAD workflows |
| **Test Architecture Enterprise** | `tea/` (9 workflows, 42 knowledge articles) | Complete test strategy framework |
| **Team configurations** | `bmm/teams/team-fullstack.yaml` | Pre-defined team compositions |
| **BMAD help** | `core/skills/bmad-help/` | Contextual methodology guidance |

---

## 6. High-Value Unused Features — Implementation Plan

Prioritized by impact on our autonomous factory capabilities:

### Priority 1 — Enhance Current Pipeline (Low effort, high value)

| # | Feature | Source | Why Valuable | Implementation |
|---|---------|--------|-------------|----------------|
| 1.1 | **Project context generation** | `bmad-generate-project-context` | Produces `project-context.md` that all agents reference. Currently missing — agents load empty context. | Wire into CEO orchestrator or run once at setup. |
| 1.2 | **Implementation readiness check** | `bmad-check-implementation-readiness` | Quality gate before dev starts. Currently we go straight to dev without validating specs. | Add as pre-dev step in `sprint-runner.ts` or CEO delegation. |
| 1.3 | **Retrospective** | `bmad-retrospective` | Post-epic lessons learned. Currently sprint ends with no learning. | Wire into sprint-runner after all stories reach "done". |
| 1.4 | **Advanced elicitation** | `bmad-advanced-elicitation` | Push LLM to self-improve output quality. Can wrap around any agent dispatch. | Inject as post-processing step in `agent-dispatcher.ts`. |

### Priority 2 — Full SDLC Automation (Medium effort, high value)

| # | Feature | Source | Why Valuable | Implementation |
|---|---------|--------|-------------|----------------|
| 2.1 | **PRD creation + validation** | `bmad-create-prd`, `bmad-validate-prd` | Close the loop: Factory can create its own requirements. | Add as PM agent tools; CEO delegates "create PRD" issues to PM. |
| 2.2 | **Architecture creation** | `bmad-create-architecture` | Factory can design its own architecture from PRD. | Add as Architect agent tool; CEO delegates "design architecture" issues. |
| 2.3 | **Epics & stories generation** | `bmad-create-epics-and-stories` | Factory can break requirements into sprint work. | Add as PM/SM tool; CEO delegates "create sprint plan" issues. |
| 2.4 | **QA E2E test generation** | `bmad-qa-generate-e2e-tests` | Factory can write E2E tests autonomously. | Add as QA agent tool; wire into post-dev pipeline. |
| 2.5 | **Course correction** | `bmad-correct-course` | Handle mid-sprint changes without manual intervention. | Wire into stall-detector escalation path. |

### Priority 3 — Specialized Capabilities (Higher effort, niche value)

| # | Feature | Source | Why Valuable | Implementation |
|---|---------|--------|-------------|----------------|
| 3.1 | **Document distillation** | `bmad-distillator` | Compress large docs for LLM context windows. Critical for large projects. | Utility tool available to all agents; compress arch docs, PRDs before injection. |
| 3.2 | **Test Architecture Enterprise** | `tea/` (9 workflows) | Full test strategy: ATDD, CI pipelines, framework setup, NFR assessment, traceability. 42 knowledge articles. | Massive value for QA agent — wire TEA workflows as QA tools. |
| 3.3 | **Research workflows** | `bmad-domain-research`, `bmad-market-research`, `bmad-technical-research` | Factory can research before building. | Wire into Analyst agent; CEO delegates "research X" issues. |
| 3.4 | **Party mode** | `bmad-party-mode` | Multi-agent roundtable discussion for design decisions. | Unique for complex architectural decisions — wire as CEO escalation for ambiguous issues. |
| 3.5 | **Agent/workflow builder** | `bmb/skills/` | Factory can create and optimize its own agents and workflows. Self-improving system. | Meta-capability — use to refine our agent prompts and heartbeat configs. |
| 3.6 | **Editorial review** | `bmad-editorial-review-prose`, `bmad-editorial-review-structure` | Polish documentation and specs. | Wire into tech-writer agent; run on generated docs. |

---

## 7. Recommendations

### Keep both folders:

1. **`_bmad/`** — It's the BMAD Method installation. Don't modify it (upstream-managed). Our agents reference it at runtime.
2. **`skills/`** — It's the Copilot SDK skill registry. Required for skill resolution.
3. **`agents/`** — Our custom 4-file Paperclip configs. These reference both `_bmad/` and `skills/`.
4. **`src/agents/`** — Our TypeScript agent definitions. Auto-generated from `_bmad/`.

### Clean up:

- The `_bmad/_config/custom/` directory is empty — fine to leave.
- The `_bmad/_config/agents/*.customize.yaml` files are all empty templates — they're valid customization points.

### Next steps:

1. **Generate `project-context.md`** (Priority 1.1) — This is the highest-value quick win. All agent prompts look for it.
2. **Wire implementation readiness check** (Priority 1.2) — Quality gate before dev.
3. **Plan Priority 2 items** as a sprint to close the full SDLC loop.
4. **Evaluate TEA module** (Priority 3.2) — 42 knowledge articles + 9 workflows is significant untapped QA capability.


Notes:
The CEO is the digital twin of the user, he must take care of deciding which workflows to start/ which agents to involved based on:
Is it a greenfield or brownfield project.
For greenfield, does he has enough context from user to start with prd and architecture. Or does he need to perform some brainstorming or research (market and technical). He needs to involved the correct agents.
After he has enough information, he can review the created project context and  prd and architecture.
After prd and architecture is decided, he is not involved anymore.
Scrum master and PO are responsible for pushing forward the sprints. devs, reviewer, tester work together for implementation.
For brownfield , CEO must try to establish the project context and work with pm/architect to get prd and architecture established.

When an issue is added, ceo must evaluate whether prd and architecture must be updated.

At any time, if a decision is difficult, he can call in party mode to talk with the round and get different opinions, this makese most sense during brainstorming and research topics and planning phase.

