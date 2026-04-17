#!/usr/bin/env bash
# Setup script: registers aweek skills in .claude/commands/ for Claude Code discovery
# Run: bash scripts/setup-skills.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
COMMANDS_DIR="$PROJECT_ROOT/.claude/commands"

echo "Setting up aweek skills..."

mkdir -p "$COMMANDS_DIR"

# Register create-agent skill
cp "$PROJECT_ROOT/skills/aweek-create-agent.md" "$COMMANDS_DIR/create-agent.md"
echo "  ✓ Registered /aweek:create-agent"

# Register approve-plan skill
cp "$PROJECT_ROOT/skills/aweek-approve-plan.md" "$COMMANDS_DIR/approve-plan.md"
echo "  ✓ Registered /aweek:approve-plan"

echo ""
echo "Done! Skills are now discoverable via Claude Code slash commands."
