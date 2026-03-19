# MCP Servers — BMAD Sprint Server

Model Context Protocol servers that expose BMAD sprint data as tools
for GitHub Copilot and other MCP-compatible clients.

## BMAD Sprint Server

**Path:** `src/mcp/bmad-sprint-server/`  
**Transport:** stdio  
**SDK:** `@modelcontextprotocol/sdk` v1.27+

### Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_sprint_status` | Read current sprint state from `sprint-status.yaml` | *(none)* |
| `get_next_story` | Get next story in `ready-for-dev` status with full markdown content | *(none)* |
| `update_story_status` | Move a story through the lifecycle (with transition validation) | `story_id`, `new_status`, `assigned?`, `increment_review_pass?` |
| `get_architecture_docs` | Read `docs/architecture.md` with optional file listing | `include_file_list?` |
| `get_story_details` | Full story details: sprint metadata + markdown content | `story_id` |

### Valid Story Lifecycle Transitions

```
backlog → ready-for-dev → in-progress → review → done
                ↑              ↑            │       │
                └──────────────┘            │       │
                  (rework after review)     │       │
                                            └───────┘
                                          (reopen for re-review)
```

### Running the Server

```bash
# Via npm script
pnpm mcp:sprint

# Directly
tsx src/mcp/bmad-sprint-server/index.ts
```

### VS Code / Copilot Integration

The server is configured in `.vscode/mcp.json` and will be automatically
discovered by GitHub Copilot Chat when the workspace is opened.

```json
{
  "servers": {
    "bmad-sprint-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["tsx", "src/mcp/bmad-sprint-server/index.ts"]
    }
  }
}
```

### Architecture

```
src/mcp/
├── index.ts                      # Barrel exports
├── README.md                     # This file
└── bmad-sprint-server/
    ├── index.ts                  # Server entry point (stdio transport)
    └── tools.ts                  # 5 MCP tool handler implementations
```

The MCP tools reuse existing utilities:
- `src/tools/sprint-status.ts` — `readSprintStatus()` / `writeSprintStatus()`
- `src/config/config.ts` — `loadConfig()` for paths and settings

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BMAD_OUTPUT_DIR` | `_bmad-output` | Directory for sprint status and story files |
| `BMAD_SPRINT_STATUS_PATH` | `_bmad-output/sprint-status.yaml` | Sprint status file path |

### Future Servers (Planned)

- **Git MCP** — Branch, commit, PR management
- **Notification MCP** — Slack/webhook notifications for story lifecycle events
