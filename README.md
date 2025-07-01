![Target Backstage Compatibility Badge](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fredhat-developer%2Frhdh-plugin-export-overlays%2Frefs%2Fheads%2Fmetadata%2Fincompatible-workspaces.json&style=flat&cacheSeconds=60&link=https://github.com/redhat-developer/rhdh-plugin-export-overlays/actions/workflows/check-backstage-compatibility.yaml?query=event%3Apush+is%3Afailure)

![Publish Images Badge](https://img.shields.io/github/actions/workflow/status/redhat-developer/rhdh-plugin-export-overlays/publish-workspace-plugins.yaml?branch=main&event=push&label=Publish%20RHDH%20Next%20Release%20Dynamic%20Plugin%20Images&link=https%3A%2F%2Fgithub.com%2Fredhat-developer%2Frhdh-plugin-export-overlays%2Factions%2Fworkflows%2Fpublish-workspace-plugins.yaml%3Fquery%3Devent%253Apush)

## What is the rhdh-plugin-export-overlays repository?

The rhdh-plugin-export-overlays repository serves as a metadata and automation hub for managing dynamic plugins for Red Hat Developer Hub (RHDH).

This repository:

- References a wide range of Backstage plugins that can or should be published as dynamic plugins for use in RHDH.

- Tracks plugin versions to ensure compatibility with the latest RHDH releases.

- Defines how to drive, customize, and automate the publishing process.

Additionally, it contains workflows to:

- Discover eligible Backstage plugins.

- Package them as OCI images for use as dynamic plugins.

- Publish these images to the GitHub Container Registry for easy integration with RHDH.

## Repository Structure & Partitioning
The content in this repository is structured as follows:

1. **By Workspace:**

Each plugin set is organized in a dedicated folder that represents a workspace—typically aligned with a monorepo hosted in a third-party GitHub repository (e.g., `@backstage-community`, `@roadiehq`, `@red-hat-developer-hub`).

1. **By RHDH Target Release:**

The repository uses long-running release branches named following the pattern `release-x.y` (e.g., `release-1.5`, `release-1.6`).
Each branch maps to a specific RHDH release version and contains plugin data that is compatible with the Backstage version shipped in that RHDH release.

## How to use the workflows in this repository to create OCI images for your plugins

### 1. Create/Look for a PR for the plugins you wish to export against the desired RHDH relase branch version 
   
   A GitHub workflow runs **daily at 12:00 PM UTC** to automatically generate or update PRs for plugins under the following scopes: `@backstage-community`, `@red-hat-developer-hub` and `@roadiehq`.
   These PRs are created **per workspace, per release branch**.
   
   If you can't find a PR for your plugin, you can manually trigger one as explained below.
   
   ### Create a PR using the "Update plugins repository references" workflow

  > [!IMPORTANT]
  > Write access to this repository is required to run this workflow.

   - Navigate to https://github.com/redhat-developer/rhdh-plugin-export-overlays/actions/workflows/update-plugins-repo-refs.yaml 
   - For "use workflow from" select main
   - For "regexps", specify the regular expression matching the plugins you want to package. For example, to package all RBAC plugins, the regexp would be "@backstage-community/plugin-rbac"
   - Running the workflow with the following inputs should generate a PR similar to [these ones](https://github.com/redhat-developer/rhdh-plugin-export-overlays/pulls/app%2Fgithub-actions)
    
   **How it works**:
   - The workflow generates PRs against each active release branch corresponding to an RHDH release.
   - For each release branch, it checks for published plugin versions compatible with the Backstage version that the RHDH release supports.
   - If no compatible version is found, no PR is generated for that plugin on that branch.

### Manually Creating a PR

You can also create PRs manually by referencing existing examples: [View PR examples](https://github.com/redhat-developer/rhdh-plugin-export-overlays/pulls/app%2Fgithub-actions)

To add a new plugin:

1. Create a new workspace in the overlay repository.
2. Add a `plugins-list.yaml` file that lists all plugins included in the target workspace of the source repository. ([See example](https://github.com/redhat-developer/rhdh-plugin-export-overlays/blob/12acb71a1febc5567c4d12c6a28c0a11ed489273/workspaces/adoption-insights/plugins-list.yaml))
3. Add a `source.json` file with the following fields ([See example](https://github.com/redhat-developer/rhdh-plugin-export-overlays/blob/12acb71a1febc5567c4d12c6a28c0a11ed489273/workspaces/adoption-insights/source.json))
:
   - `repo`: URL of the source repository  (only `https://github.com/xxx` URLs are supported for now)
   - `repo-ref`: Specific tag or commit for the target plugin/workspace version  
   - `repo-flat`:  
     - `false` if the plugins are inside a workspace (e.g., `backstage/community-plugins`)  
     - `true` if the plugins are at the root level (e.g., `backstage/backstage`)

### 3. Add Additional Dynamic Plugin Export Information (If Needed)

Sometimes, additional configuration is required in the PR:

- **Frontend plugins** may need:
   - `app-config.dynamic.yaml` (Eg: [techdocs plugin](https://github.com/redhat-developer/rhdh-plugin-export-overlays/blob/release-1.5/workspaces/backstage/plugins/techdocs/app-config.dynamic.yaml))
   - `scalprum-config.json` (Eg: [api-docs-module-protoc-gen-doc plugin](https://github.com/redhat-developer/rhdh-plugin-export-overlays/blob/release-1.5/workspaces/backstage/plugins/api-docs-module-protoc-gen-doc/scalprum-config.json))

- **Any plugin** may need:
   - Overlay source files in an `overlay` directory  
  (e.g., [`api-docs-module-protoc-gen-doc`](https://github.com/redhat-developer/rhdh-plugin-export-overlays/tree/release-1.5/workspaces/backstage/plugins/api-docs-module-protoc-gen-doc/overlay))
  - A patch file at the root of the workspace to modify the workspace source code before the packaging process. (Example: PR [#792](https://github.com/redhat-developer/rhdh-plugin-export-overlays/pull/792/files#diff-0b648cbca6f87e11f78832c10ac9cc789235938e944c499eb275fd8788e18ef8))

> **Overlay vs. Patch**  
> - **Overlay**: Replaces or adds entire files during the packaging process.  
> - **Patch**: Applies precise, line-by-line changes to existing source files.  


To add this additional configuration (excluding the patch, since the patch file is placed at the workspace [monorepo] root):
- Create a `plugins/` folder within the appropriate `workspace/`
- Inside `plugins/`, create one folder per plugin you wish to enhance with additional information


### 4. Test the OCI image against an RHDH instance
- To trigger a build of the OCI image for the plugins in a PR, comment: `/publish`. 
- This runs a GitHub workflow to build and publish **test OCI artifacts**. A bot will comment with the generated OCI image references, tagged as `<pr_number>_<plugin_version>`, and may also include a list of plugins for which the generation failed.
- If you cannot test the generated images immediately, a good practice is to label the PR with `help wanted to test`.

#### Once Testing Is Complete:
- If the plugin works with your RHDH instance, **change the label** to `tested`
- Once the PR is merged, the final OCI artifact will be published with the tag: `bs_<backstage_version>__<plugin_version>`
