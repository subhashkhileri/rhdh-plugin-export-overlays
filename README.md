## What is the rhdh-plugin-export-overlays reposiotry?

This repository contains workflows to package Backstage plugins (under the following npm scopes: @backstage-community, @red-hat-developer-hub and @roadiehq) as OCI images to be used as dynamic plugins within Red Hat Developer Hub (RHDH).

## How to use the workflows in this repository to create OCI images for your plugins

### 1. Create/Look for a PR for the plugins you wish to export against the desired RHDH relase branch version 
   
   A GitHub workflow runs **daily at 12:00 PM UTC** to automatically generate or update PRs for plugins under the supported scopes. These PRs are created **per workspace, per release branch**.
   
   If you can't find a PR for your plugin, you can manually trigger one as explained below.
   
   #### Create a PR using the "Update plugins repository references" workflow

    > **Important**: You need write access to this repository to run the workflow.

      - Navigate to https://github.com/redhat-developer/rhdh-plugin-export-overlays/actions/workflows/update-plugins-repo-refs.yaml 
      - For "use workflow from" select main
      - For "regexps", specify the regular expression matching the plugins you want to package. For example, to package all RBAC plugins, the regexp would be "@backstage-community/plugin-rbac"
      - Running the workflow with the following inputs should generate a PR similar to [these ones](https://github.com/redhat-developer/rhdh-plugin-export-overlays/pulls/app%2Fgithub-actions)
    
    **How it works**:
   - The workflow generates PRs against each active release branch corresponding to an RHDH release.
   - For each release branch, it checks for plugin versions compatible with the Backstage version that the release supports.
   - If no compatible version is found, no PR is generated for that plugin on that branch.

### 3. Add Additional Dynamic Plugin Export Information (If Needed)

Sometimes, additional configuration is required in the PR:

- **Frontend plugins** may need:
- [`app-config.dynamic.yaml`](https://github.com/redhat-developer/rhdh-plugin-export-overlays/blob/release-1.5/workspaces/backstage/plugins/techdocs/app-config.dynamic.yaml)
- [`scalprum-config.json`](https://github.com/redhat-developer/rhdh-plugin-export-overlays/blob/release-1.5/workspaces/backstage/plugins/api-docs-module-protoc-gen-doc/scalprum-config.json)

- **Any plugin** may need:
- Overlay source files in an `overlay` directory  
  (e.g., [`api-docs-module-protoc-gen-doc`](https://github.com/redhat-developer/rhdh-plugin-export-overlays/tree/release-1.5/workspaces/backstage/plugins/api-docs-module-protoc-gen-doc/overlay))

To add this:
- Create a `plugins/` folder within the appropriate `workspace/`
- Inside `plugins/`, create one folder per plugin you wish to enhance with additional information


### 4. Test the OCI image against an RHDH instance
- To trigger a build of the OCI image for the plugins in a PR, comment: `/publish`. 
- This runs a GitHub workflow to build and publish **test OCI artifacts**. A bot will comment with links to the artifacts (tagged as `<pr_number>_<plugin_version>`) and the PR will be labeled `help wanted to test`.
- 

#### Once Testing Is Complete:
- If the plugin works with your RHDH instance, **change the label** to `tested`
- Once the PR is merged, the final OCI artifact will be published with the tag: `bs_<backstage_version>__<plugin_version>`