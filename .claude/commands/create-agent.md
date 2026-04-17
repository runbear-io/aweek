---
name: aweek:create-agent
description: Create a new aweek agent with identity, goals, and initial plan via interactive prompts
trigger: create agent, new agent, add agent, aweek create agent
---

# aweek:create-agent

Create a new aweek agent interactively. This skill collects agent identity, long-term goals, and an initial monthly/weekly plan, validates all input against schemas, and persists the agent using the storage layer.

## Instructions

You MUST follow this exact workflow when this skill is invoked. Use the project's Node.js modules in `src/skills/create-agent.js` — never write agent JSON files directly.

### Step 1: Collect Agent Identity

Ask the user for each field one at a time using AskUserQuestion. Do NOT proceed until all required fields are provided and non-empty.

1. **Name** (required, 1-100 chars): Ask for the agent's name.
   - Example: "ResearchBot", "ContentWriter", "CodeReviewer"

2. **Role** (required, 1-200 chars): Ask for a brief description of the agent's role.
   - Example: "Researches technical topics and summarizes findings"

3. **System Prompt** (required): Ask for the system prompt / personality for Claude Code sessions.
   - Example: "You are a meticulous research assistant who produces well-cited summaries."

4. **Weekly Token Budget** (optional, default 500000): Ask for the weekly token limit.
   - Must be a positive integer. Default: 500,000 tokens.

### Step 2: Collect Long-Term Goals

Ask the user for 1-5 long-term goals for this agent.

- Ask: "What are the long-term goals for this agent? Enter one per message, type 'done' when finished (minimum 1, maximum 5)."
- Each goal must be at least 10 characters
- Keep asking until user says "done" or 5 goals reached

### Step 3: Collect Initial Monthly Plan

Ask the user for objectives for the current month. Each objective must reference a goal from Step 2.

1. Display the numbered list of goals collected
2. For each objective ask:
   - The objective description
   - Which goal number it relates to
3. Collect 1-5 objectives (ask until "done" or 5 reached)

### Step 4: Collect Initial Weekly Plan

Ask the user for tasks for the current week. Each task must reference an objective from Step 3.

1. Display the numbered list of objectives collected
2. For each task ask:
   - The task description
   - Which objective number it relates to
3. Collect 1-10 tasks (ask until "done" or 10 reached)
4. Note: The weekly plan starts as `approved: false`

### Step 5: Validate and Save

After collecting all information, run a Node.js script using the `assembleAndSaveAgent` function from `src/skills/create-agent.js`:

```bash
node --input-type=module -e "
import { assembleAndSaveAgent, formatAgentSummary } from './src/skills/create-agent.js';

const result = await assembleAndSaveAgent({
  name: '<NAME>',
  role: '<ROLE>',
  systemPrompt: '<SYSTEM_PROMPT>',
  weeklyTokenLimit: <LIMIT>,
  goalDescriptions: [<GOALS>],
  objectives: [<OBJECTIVES>],
  tasks: [<TASKS>],
});

if (!result.success) {
  console.error('ERRORS:', JSON.stringify(result.errors));
  process.exit(1);
}

console.log(formatAgentSummary(result.config));
"
```

Replace the placeholders with the actual collected values, properly JSON-escaped.

If validation fails, report the specific errors and re-collect only the invalid fields, then retry.

If save succeeds, display the formatted summary to the user.

## Validation Rules

- Agent name: 1-100 chars, non-empty
- Agent role: 1-200 chars, non-empty
- System prompt: non-empty string
- Weekly token limit: positive integer, default 500000
- Goals: 1-5 goals, each description >= 10 chars
- Monthly objectives: 1-5, each must reference a valid goal
- Weekly tasks: 1-10, each must reference a valid objective
- All artifacts validated against JSON schemas before save

## Error Handling

- If the user provides empty or invalid input, explain what's wrong and re-ask
- If schema validation fails after assembly, show the specific errors and allow correction
- The storage layer auto-creates the data directory if needed
- The agent ID includes a random suffix so collisions are extremely unlikely

## Data Directory

Agents are stored in `.aweek/agents/<agent-id>.json` relative to the project root.
