# Bot marketplace

The **Create bot** action offers **Create from scratch** or **Choose a template**. Choosing a template opens a curated catalog of Busy bots. Users can search by job, name, creator, example prompt, or suggested app, and filter by category. Featured templates appear first when browsing the full catalog.

Selecting a card opens a detail view with example requests, optional apps, and the complete instructions. **Use template** opens a simple form for the robot's color, name, and what the bot does. Every bot uses the Pix robot avatar. The hub loads the template's instructions by its catalog ID and chooses a Token Pass model with Decision API. Instructions, model, billing, and Fast can be changed in the bot's settings after creation. See [Bot creation](bot-creation.md) for model selection and fallback behavior.

Browsing and selecting a template do not create or deploy a bot. Only **Create bot** submits to the existing `POST /api/bots` endpoint and starts its deployment workflow. Suggested apps are informational: skills, plugins, connections and their authorization are managed once in the app settings, independently of bot creation. Every bot chooses which enabled skills and connected tools fit the task.

**Start from scratch** opens the same creator without template values. **Back** from the creator or marketplace returns to the initial creation choices. The current draft is preserved; choosing **Choose a template** and then **Continue draft** resumes it. Choosing a template or starting from scratch starts a new draft. Closing the creator discards the draft. Editing an existing bot opens its settings directly and retains the existing patch behavior.

## Catalog maintenance

The catalog lives in `apps/hub/lib/bots/marketplace.ts`. Each template has a stable ID, author, category, existing Pix avatar, short description, instructions, starter prompts, suggested apps, and featured flag. This initial catalog is maintained in source; publishing user-created listings is outside this version.

Keep names within 60 characters, descriptions within 140, and instructions within 8,000, matching the bot API. Template content describes a usable workflow and asks for needed inputs instead of assuming connected accounts or inventing evidence.

## Verification

```sh
pnpm exec vitest run apps/hub/lib/bots/marketplace.test.ts apps/hub/bot-marketplace.test.tsx
pnpm typecheck
```

The interaction tests cover search and category filters, detail review, editable template creation, failure and retry, blank creation, draft preservation, reopening, and existing-bot edits.
