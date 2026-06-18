#!/usr/bin/env bash
set -euo pipefail

# coord-template init — bootstrap a new project from the template
#
# Usage:
#   bash /path/to/coord-template/init.sh [options]
#
# Run this from your project root (parent of your repo directories).
#
# Options:
#   --repo CODE:name    Register a repo (e.g., --repo B:api --repo F:web --repo M:mobile)
#                       CODE is a single uppercase letter used in the board's Repo column.
#                       X is reserved for coord/cross-repo work.
#                       If no --repo flags are given, defaults to B:backend F:frontend.
#   --project <name>    Project display name for the board (default: directory name)
#   --no-git            Do not git-init the project root (default: init + initial
#                       commit when the root is not already inside a git repo,
#                       so governed `gov sync`/`doctor` work out of the box)
#   --dry-run           Show what would be copied without doing it
#   -h, --help          Show this help
#
# Examples:
#   bash init.sh                                          # Default: B=backend, F=frontend
#   bash init.sh --repo B:api --repo F:dashboard          # Two repos, custom names
#   bash init.sh --repo B:server                          # Single repo
#   bash init.sh --repo B:api --repo F:web --repo M:mobile --repo W:worker  # Four repos

TEMPLATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="$(pwd)"
PROJECT_NAME="$(basename "$TARGET_DIR")"
DRY_RUN=0
GIT_INIT=1

declare -a REPO_ENTRIES=()

usage() {
  sed -n '3,27p' "${BASH_SOURCE[0]}" | sed 's/^# //' | sed 's/^#//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      if [[ $# -lt 2 ]]; then echo "Missing value for --repo" >&2; exit 2; fi
      REPO_ENTRIES+=("$2"); shift 2 ;;
    --backend)
      # Legacy compat
      REPO_ENTRIES+=("B:$2"); shift 2 ;;
    --frontend)
      # Legacy compat
      REPO_ENTRIES+=("F:$2"); shift 2 ;;
    --project)  PROJECT_NAME="$2"; shift 2 ;;
    --no-git)   GIT_INIT=0; shift ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *)          echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# Default repos if none specified
if [[ ${#REPO_ENTRIES[@]} -eq 0 ]]; then
  REPO_ENTRIES=("B:backend" "F:frontend")
fi

# Parse and validate repo entries
declare -A REPOS=()
for entry in "${REPO_ENTRIES[@]}"; do
  if [[ ! "$entry" =~ ^([A-Z]):(.+)$ ]]; then
    echo "ERROR: Invalid --repo format: '$entry'. Use CODE:name (e.g., B:api)" >&2
    exit 2
  fi
  code="${BASH_REMATCH[1]}"
  name="${BASH_REMATCH[2]}"
  if [[ "$code" == "X" ]]; then
    echo "ERROR: Code 'X' is reserved for coord/cross-repo work." >&2
    exit 2
  fi
  REPOS["$code"]="$name"
done

run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  [dry-run] $*"
  else
    "$@"
  fi
}

echo "Initializing coord governance in: $TARGET_DIR"
echo "  Project: $PROJECT_NAME"
echo "  Repos:"
for code in $(echo "${!REPOS[@]}" | tr ' ' '\n' | sort); do
  echo "    $code = ${REPOS[$code]}"
done
echo ""

# --- Check prerequisites ---

if [[ -d "$TARGET_DIR/coord" ]]; then
  echo "ERROR: coord/ already exists in $TARGET_DIR. Remove it first or use a clean directory." >&2
  exit 1
fi

# --- Copy template ---

echo "Copying governance scaffold..."
run cp -R "$TEMPLATE_DIR/coord" "$TARGET_DIR/coord"
# A fresh project must NOT inherit this template's runtime/journal/locks/
# session bindings or its development-history archive. These are scrubbed
# from the copy so the new board starts from a clean baseline.
run rm -rf "$TARGET_DIR/coord/.runtime" \
           "$TARGET_DIR/coord/.worktrees" \
           "$TARGET_DIR/coord/prompts/tickets" \
           "$TARGET_DIR/coord/docs/DEV_HISTORY.md"
run mkdir -p "$TARGET_DIR/.claude/commands"

if [[ -d "$TEMPLATE_DIR/.claude/commands" ]]; then
  run cp "$TEMPLATE_DIR/.claude/commands/"*.md "$TARGET_DIR/.claude/commands/" 2>/dev/null || true
fi
if [[ -d "$TEMPLATE_DIR/.claude/skills" ]]; then
  run cp -R "$TEMPLATE_DIR/.claude/skills" "$TARGET_DIR/.claude/skills" 2>/dev/null || true
fi
if [[ -f "$TEMPLATE_DIR/.claude/settings.json" ]]; then
  run cp "$TEMPLATE_DIR/.claude/settings.json" "$TARGET_DIR/.claude/settings.json"
fi

run cp "$TEMPLATE_DIR/.mcp.json" "$TARGET_DIR/.mcp.json"

for shim in CLAUDE.md CODEX.md GEMINI.md AGENTS.md; do
  if [[ ! -f "$TARGET_DIR/$shim" ]]; then
    run cp "$TEMPLATE_DIR/$shim" "$TARGET_DIR/$shim"
  else
    echo "  Skipping $shim (already exists)"
  fi
done

# --- Configure project repo config ---

if [[ $DRY_RUN -eq 0 ]]; then
  echo "Configuring project repo map..."

  # Build coord/project.config.js. Repo paths are project-owned config; paths.js
  # is engine-managed and reads this file.
  config_content="// coord/project.config.js - project-owned config seam (GCV-4).\n"
  config_content+="module.exports = {\n"
  config_content+="  repos: {\n"
  for code in $(echo "${!REPOS[@]}" | tr ' ' '\n' | sort); do
    config_content+="    ${code}: {\n"
    config_content+="      path: \"${REPOS[$code]}\",\n"
    config_content+="      integrationBranch: \"dev\",\n"
    config_content+="      origin: null,\n"
    config_content+="      legacyAliases: [],\n"
    config_content+="    },\n"
  done
  config_content+="  },\n"
  config_content+="  requirements: {\n"
  config_content+="    path: \"product/REQUIREMENTS.md\",\n"
  config_content+="  },\n"
  config_content+="};\n"
  printf "%b" "$config_content" > "$TARGET_DIR/coord/project.config.js"

  # --- Update product/REPOS.md ---

  # Generate repo sections
  repos_content="# Repository Layout\n\nThis project uses the following repos.\n\n## Directory Structure\n\n\`\`\`text\n$(basename "$TARGET_DIR")/\n"
  for code in $(echo "${!REPOS[@]}" | tr ' ' '\n' | sort); do
    repos_content+="├── ${REPOS[$code]}/\n"
  done
  repos_content+="└── coord/\n\`\`\`\n\n## Repo Codes\n\n| Code | Directory | Role |\n|---|---|---|\n"
  for code in $(echo "${!REPOS[@]}" | tr ' ' '\n' | sort); do
    repos_content+="| \`$code\` | \`${REPOS[$code]}/\` | |\n"
  done
  repos_content+="| \`X\` | \`coord/\` | Cross-repo, design, planning |\n"
  printf "$repos_content" > "$TARGET_DIR/coord/product/REPOS.md"

  # --- Update GOVERNANCE.md repo references ---

  # Build repo code table
  gov_codes=""
  for code in $(echo "${!REPOS[@]}" | tr ' ' '\n' | sort); do
    gov_codes+="- \`$code\` = \`${REPOS[$code]}\`\n"
  done
  gov_codes+="- \`X\` = cross-repo, design, planning, or coord-owned work"

  python3 -c "
import re
with open('$TARGET_DIR/coord/GOVERNANCE.md', 'r') as f:
    content = f.read()
# Replace repo code section
content = re.sub(
    r'## 6\\) Repo Codes\\n\\n.*?(?=\\n## 7\\) Worktree Rules)',
    '''## 6) Repo Codes

Repo codes are defined in coord/project.config.js. Each code is a single uppercase letter mapping to a repo directory. X is always reserved for coord/cross-repo work.

Configured repo codes:
${gov_codes}

The governance CLI, board validator, and MCP server read project config through coord/paths.js; edit coord/project.config.js, not engine-managed paths.js.

''',
    content,
    flags=re.DOTALL
)
with open('$TARGET_DIR/coord/GOVERNANCE.md', 'w') as f:
    f.write(content)
"

  # --- Update AGENTS.md repo-local guides ---

  agents_lines=""
  for code in $(echo "${!REPOS[@]}" | tr ' ' '\n' | sort); do
    agents_lines+="- \`${REPOS[$code]}/AGENTS.md\`\n"
  done
  agents_lines+="- \`coord/AGENTS.md\`"

  python3 -c "
import re
with open('$TARGET_DIR/AGENTS.md', 'r') as f:
    content = f.read()
content = re.sub(
    r'Repo-local agent guides:\n(- \\\`[^\n]+\n)+',
    '''Repo-local agent guides:
${agents_lines}
''',
    content
)
with open('$TARGET_DIR/AGENTS.md', 'w') as f:
    f.write(content)
"

  # --- Update shim files ---

  for shim in CLAUDE.md CODEX.md GEMINI.md; do
    if [[ -f "$TARGET_DIR/$shim" ]]; then
      python3 -c "
import re
with open('$TARGET_DIR/$shim', 'r') as f:
    content = f.read()
content = re.sub(
    r'Repo-local agent guides:\n(- \\\`[^\n]+\n)+',
    '''Repo-local agent guides:
${agents_lines}
''',
    content
)
with open('$TARGET_DIR/$shim', 'w') as f:
    f.write(content)
"
    fi
  done

  # --- Seed a CLEAN board ---

  # A fresh project must NOT inherit the template's development backlog (its
  # done/in-flight tickets and template-only repo codes). Replace the board's
  # ticket sections with a clean Phase-0 seed backlog derived from the
  # configured repos, and reset all lifecycle index maps. Metadata (canonical
  # references, thresholds) is preserved; only the title and ticket content are
  # reset.
  repos_json="{"
  first=1
  for code in $(echo "${!REPOS[@]}" | tr ' ' '\n' | sort); do
    [[ $first -eq 0 ]] && repos_json+=","
    repos_json+="\"$code\":\"${REPOS[$code]}\""
    first=0
  done
  repos_json+="}"

  COORD_INIT_REPOS="$repos_json" COORD_INIT_PROJECT="$PROJECT_NAME" \
  node -e '
    const fs = require("fs");
    const target = process.argv[1];
    const boardPath = target + "/coord/board/tasks.json";
    const repos = JSON.parse(process.env.COORD_INIT_REPOS || "{}");
    const project = process.env.COORD_INIT_PROJECT || "Project";
    const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    board.metadata = board.metadata || {};
    board.metadata.title = project + " Task Board";
    board.metadata.last_updated = new Date().toISOString();
    const codes = Object.keys(repos).sort();
    const rows = [{
      ID: "SETUP-001", Repo: "X", Type: "docs", Pri: "P0", Status: "todo",
      Owner: "unassigned",
      Description: "Tailor this coord scaffold for the project: repo names, prompts, validation hooks, and starter process notes. See coord/SCAFFOLD_TAILORING_CHECKLIST.md.",
      "Depends On": "",
    }];
    const promptIndex = { "SETUP-001": "coord/prompts/planner.md" };
    let n = 2;
    for (const code of codes) {
      const id = "SETUP-" + String(n).padStart(3, "0");
      rows.push({
        ID: id, Repo: code, Type: "scaffold", Pri: "P0", Status: "todo",
        Owner: "unassigned",
        Description: "Bootstrap the " + repos[code] + " repo: environment loading, auth seams, quality gates, and an initial module boundary layout. See " + repos[code] + "/BOOTSTRAP.md.",
        "Depends On": "SETUP-001",
      });
      promptIndex[id] = "coord/prompts/implementer.md";
      n++;
    }
    board.sections = [{
      kind: "markdown", level: 2, heading: "Phase 0: Workspace Foundation",
      separator_before: true,
      body: ["Seed backlog generated by init.sh. Replace these with your real tickets."],
    }, {
      kind: "table", level: 3, heading: "Seed Backlog", separator_before: false,
      columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
      rows,
    }];
    board.prompt_index = promptIndex;
    for (const key of ["pr_index", "landing_index", "review_findings", "waiver_index", "followup_exceptions"]) {
      board[key] = {};
    }
    fs.writeFileSync(boardPath, JSON.stringify(board, null, 2) + "\n", "utf8");
    console.log("Seeded clean board: " + rows.length + " starter ticket(s) across repos [" + (codes.join(", ") || "none") + "].");
  ' "$TARGET_DIR"

  # Regenerate derived artifacts (rendered board, PLAN.md) from the clean board.
  node "$TARGET_DIR/coord/board/board.js" sync >/dev/null 2>&1 || true

else
  echo "  [dry-run] Would configure ${#REPOS[@]} repos in coord/project.config.js, coord/product/REPOS.md, coord/GOVERNANCE.md, and AGENTS.md"
fi

# --- Initialize git ---

# Governed `gov sync` and `gov doctor` resolve the repo root via
# `git rev-parse --show-toplevel`; coord/ must therefore live inside a git repo.
# If the project root is not already in one, initialize it and commit the
# governance scaffold so the board is governable immediately. Product repo
# directories are intentionally NOT added here — they are managed separately
# (see coord/product/REPOS.md). Use --no-git to skip.
if [[ $GIT_INIT -eq 1 ]]; then
  if git -C "$TARGET_DIR" rev-parse --show-toplevel >/dev/null 2>&1; then
    echo "Git: project root is already inside a git repo; skipping git init."
  else
    echo "Initializing git repo at project root..."
    if [[ $DRY_RUN -eq 1 ]]; then
      echo "  [dry-run] git init + commit governance scaffold"
    else
      git -C "$TARGET_DIR" init -q
      # Track the governance scaffold and shared agent files only.
      for tracked in coord .claude .mcp.json CLAUDE.md CODEX.md GEMINI.md AGENTS.md; do
        [[ -e "$TARGET_DIR/$tracked" ]] && git -C "$TARGET_DIR" add "$tracked" 2>/dev/null || true
      done
      git -C "$TARGET_DIR" -c user.name="coord-init" -c user.email="coord-init@localhost" \
        commit -q -m "chore: bootstrap coord governance scaffold" 2>/dev/null \
        && echo "  Committed governance scaffold." \
        || echo "  WARNING: git commit failed (set git user.name/email and commit manually)."
    fi
  fi
else
  echo "Git: --no-git set; skipping git init. NOTE: coord/ must be inside a git"
  echo "     repo for 'gov sync' and 'gov doctor' to work — run 'git init' yourself."
fi

# --- Validate ---

echo ""
echo "Validating..."

if [[ $DRY_RUN -eq 0 ]]; then
  node "$TARGET_DIR/coord/board/board.js" validate 2>&1 || echo "WARNING: Board validation had issues. Run 'node coord/board/board.js sync' after editing tasks.json."
fi

# --- Summary ---

echo ""
echo "Done. Repo config:"
for code in $(echo "${!REPOS[@]}" | tr ' ' '\n' | sort); do
  echo "  $code = ${REPOS[$code]}"
done

echo ""
echo "Choose your agent path:"
echo "  Codex : read CODEX.md and coord/AGENT_PATHS.md"
echo "  Claude: read CLAUDE.md and use .claude/commands"
echo "  Gemini: read GEMINI.md and coord/AGENT_PATHS.md"
echo "  Shared governance: coord/GOVERNANCE.md and coord/scripts/gov"
echo "  X = coord (reserved)"

echo ""
echo "Next steps:"
echo ""
echo "  1. Edit coord/board/tasks.json — replace seed tickets with your backlog"
echo "  2. Populate spec stubs (coord/product/REQUIREMENTS.md, coord/product/ARCHITECTURE.md, etc.)"
echo "  3. Run: node coord/board/board.js sync"
echo "  4. Pick your agent path:"
echo "     Codex  -> read CODEX.md and coord/AGENT_PATHS.md"
echo "     Claude -> read CLAUDE.md and run: /initiate"
echo "     Gemini -> read GEMINI.md and coord/AGENT_PATHS.md"
echo ""
echo "  To add a repo later:"
echo "    1. Edit coord/project.config.js — add to repos (e.g., M: { path: \"mobile\" })"
echo "    2. Update coord/product/REPOS.md and AGENTS.md"
echo "    3. Use the new code in board tickets (Repo: M)"
echo ""
echo "  To remove a repo:"
echo "    1. Remove from repos in coord/project.config.js"
echo "    2. Reassign or supersede tickets using that repo code"
