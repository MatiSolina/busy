# Skills and plugins

Open **Skills, plugins and MCPs** beside the account menu or from app Settings.
A centered modal manages the shared app configuration with **Skills**,
**Plugins** and **MCPs** tabs. It works before any bot has been created and is
independent of the selected chat. On small screens it fills the viewport.
Bot creation and editing contain only the bot’s own settings.

Every bot sees the enabled app skills and connected tools. The bot chooses which
ones fit the current task and loads a skill’s instructions on demand through
`eve__skill`; installing a package does not make every bot use it on every task.

The **Skills** tab shows the installed list, a search field and one **Add skill**
menu. That menu groups **Browse skills.sh**, **Create skill**, **Import SKILL.md**
and **Import folder**. In the catalog, search by task and optionally expand
**Filter by publisher**, review a skill's instructions and supporting files,
then choose **Install skill**. **Your skills** returns to the installed list.
Installed catalog skills use the same enable, edit and remove controls as custom
skills. The **Plugins** tab has one **Add plugin** action to choose a local folder
and review its contents before adding it.

## Built-in discovery

Every bot built from the template includes `find-skills`, adapted from Vercel's
MIT-licensed skill. Its pinned source, license and adaptation are recorded in
`docs/provenance/find-skills.json`. It appears as **Included** in the interface
and is available without a database installation or a sandbox startup.

The bot can proactively load it when a task needs a specialized workflow. Its
`find_skills` and `preview_skill` tools search and inspect candidates through the
hub. If the user authorizes adding a skill, `install_skill` installs the reviewed
revision in the shared app catalog and returns the name to load through `eve__skill`. Searching alone does
not install a package. Read-only consultations cannot install skills, and they do
not get `find_skills` or `preview_skill` either, because the query or id would
leave Busy for skills.sh.

### Accepted risk: installation autonomy (H-01)

Installing from the chat without a separate human approval step is a deliberate
product decision: #107 restricted it and #109 (`a6ebb7f3`) restored the autonomy.
The state-machine audit confirmed the surface (H-01) and it is recorded as
`ACCEPTED_RISK`, not as fixed. Routine executions, code-task completion notices
and child sessions can also reach `install_skill`; that is accepted too, and
restricting those contexts needs an explicit product decision. Instructions that
ask the model to install only with the user's authorization are a policy, not a
check the server can verify.

What is enforced in code:

- consultations, with either the legacy peer OIDC principal or the hub-signed
  consultation credential, never get `install_skill`, and its `execute` rejects
  them again, including a call offered earlier or replayed through `eve__tool`
  (`templates/bot/agent/tools/install_skill.test.ts`);
- the hub installs only the exact reviewed snapshot: a preview that changed
  upstream rejects the earlier hash (`apps/hub/skills-catalog.test.ts`);
- the hub checks the calling bot's identity and existence, the package limits and
  validation, and installation stays idempotent.

Lazy tool loading is not a guard. A deferred tool remains callable through
`eve__tool`; the denial comes from the tool's own dynamic resolver and its
execution check (docs/lazy-tools.md).

The hub calls the [official skills.sh API](https://www.skills.sh/docs/api) with its
existing Vercel OIDC identity. No new API key is needed. It fetches snapshots from
the fixed catalog origin, validates instructions and file paths, and computes a
SHA-256 digest over the canonical skill id and sorted file contents. Installation
re-fetches and compares that digest, so a changed package must be reviewed again.
The upstream registry hash is retained as provenance.

Repeated installation of the same revision reuses the existing row. Reinstalling
a disabled copy of that revision enables it again. New revisions and locally
edited copies are never silently overwritten. Skill packages support up to 128
supporting text files, within the existing content-size limits.

Skills can be written in the panel, imported from a `SKILL.md`, or imported as a
folder containing `SKILL.md` and supporting text files. Review the instructions
before installing them. Installed skills can be edited, disabled or removed.
Supporting files survive edits to the instructions.

Plugins import compatible Claude/Codex skill packages from a local folder. The
importer recognizes `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`
and portable root `plugin.json` manifests. It reads skill metadata and preserves
their supporting text files. The preview lists the package version, skills and
instructions before installation. Plugins enable and disable as one package.

Compatibility currently covers **skills and their supporting text files**.
Packages declaring MCP servers, app connectors, hooks, commands, agents or other
unsupported runtime components are rejected with an explanation. Empty scaffold
configuration is allowed. Connect external services separately in the MCP tab.
Binary assets and ZIP archives are not supported by this importer.
Skill settings that Busy cannot enforce, including tool restrictions, hooks,
model overrides, forked contexts and disabled model invocation, are also rejected.

Manifest references:

- [Claude plugin manifest](https://code.claude.com/docs/en/plugins-reference)
- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins)

## Persistence and runtime

`app_capabilities` stores the reviewed skill instructions and supporting files
in the hub database, independently of bots. The signed-in account manages
installations through `/api/capabilities` and installs catalog revisions through
`POST /api/skills`. The existing session gate and cross-site write protection
apply. Deleting a bot leaves the app’s installed skills and plugins intact.

All authenticated bots read the same enabled app skills from
`/api/bot/capabilities` using their existing Vercel OIDC identity. Eve resolves the dynamic skill map before
each ordinary model call. Changes apply to the next model call without replacing
the chat session. Already loaded instructions and earlier tool results remain in
conversation history. Disabling a skill withdraws it from subsequent discovery;
it cannot undo work already performed.

Eve installs supporting files in each skill's sandbox directory. Importing a
package does not execute its scripts; the agent can use those scripts later as
part of an authorized task. Invalid or unavailable manifests fail closed.

## Rollout

1. Apply `apps/hub/drizzle/0010_bot_capabilities.sql` and then
   `apps/hub/drizzle/0012_app_capabilities.sql` before releasing the hub.
   The app migration preserves existing installations and their runtime ids.
   Conflicting display names receive stable suffixes. A migration ledger prevents
   reruns from restoring removed app installations. If the combined enabled set
   exceeds the shared runtime limits, the copy rolls back with an explicit error;
   review the enabled set before retrying instead of dropping packages.
2. Deploy the updated hub and bundled bot template.
3. Redeploy existing bots once to include `agent/skills/marketplace.ts`, the
   built-in `find-skills`, its three tools and the shared-capability selection
   instructions, preserving their existing session ids. New bots include them automatically.

After this initial update, skill installation, editing, enabling and removal
need no bot redeploy. The migration and production rollout are separate from the
local implementation and automated verification.

Apply the app migrations before releasing the updated hub. Merging this source
change does not apply database migrations or redeploy existing bots.
