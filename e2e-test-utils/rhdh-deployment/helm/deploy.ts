#!/usr/bin/env zx

import { $ } from "zx";

// Enable verbose output and throw on errors
$.verbose = true;
$.spawn

// Check if the required parameters are provided
if (process.argv.length !== 4) {
  console.error("Usage: deploy.ts <namespace> <version>");
  process.exit(1);
}

const namespace = process.argv[2];
const version = process.argv[3];
const github = 0; // by default don't use the Github repo unless the chart doesn't exist in the OCI registry

// Get cluster router base
const clusterRouterBaseResult =
  await $`oc get route console -n openshift-console -o=jsonpath='{.spec.host}'`;
const CLUSTER_ROUTER_BASE = clusterRouterBaseResult.stdout
  .trim()
  .replace(/^[^.]*\./, "");
process.env.CLUSTER_ROUTER_BASE = CLUSTER_ROUTER_BASE;

// Validate version and determine chart version
let CV: string;

if (/^([0-9]+(\.[0-9]+)?)$/.test(version)) {
  // Numeric version like "1.4"
  const tagsResult =
    await $`curl -s https://quay.io/api/v1/repository/rhdh/chart/tag/?onlyActiveTags=true&limit=600`;
  const tagsData = JSON.parse(tagsResult.stdout);
  const matchingTags = tagsData.tags
    .map((tag: any) => tag.name)
    .filter((name: string) => name.startsWith(`${version}-`))
    .sort();

  if (matchingTags.length === 0) {
    console.error(`Error: No matching helm chart version found for ${version}`);
    process.exit(1);
  }

  CV = matchingTags[matchingTags.length - 1];
} else if (/CI$/.test(version)) {
  // Version ending with "CI"
  CV = version;
} else {
  console.error(`Error: Invalid helm chart version: ${version}`);
  process.exit(1);
}

const CHART_URL = "oci://quay.io/rhdh/chart";
console.log(`Using Helm chart version: ${CV} and CHART_URL: ${CHART_URL}`);

// Check if helm chart exists
try {
  await $`helm show chart ${CHART_URL} --version ${CV}`.quiet();
} catch (error) {
  console.error("Error: Helm chart not found");
  process.exit(1);
}

// RHDH URL
const RHDH_BASE_URL = `https://redhat-developer-hub-${namespace}.${CLUSTER_ROUTER_BASE}`;
process.env.RHDH_BASE_URL = RHDH_BASE_URL;

// Apply secrets
await $`envsubst < config/rhdh-secrets.yaml | oc apply -f - --namespace=${namespace}`;

// Read dynamic-plugins.yaml and prepare the helm values override
const dynamicPluginsContent = await $`cat config/dynamic-plugins.yaml`.quiet();
const indentedDynamicPlugins = dynamicPluginsContent.stdout
  .split("\n")
  .map((line) => `    ${line}`)
  .join("\n");
const dynamicPluginsOverride = `global:\n  dynamic:\n${indentedDynamicPlugins}`;

// Install/upgrade Helm chart
await $`echo ${dynamicPluginsOverride} | helm upgrade redhat-developer-hub -i ${CHART_URL} --version ${CV} \
  -f helm/value_file.yaml \
  -f /dev/stdin \
  --set global.clusterRouterBase=${CLUSTER_ROUTER_BASE} \
  --namespace=${namespace}`;

// Restart the deployment to ensure fresh pods
await $`oc rollout restart deployment/redhat-developer-hub -n ${namespace}`;

console.log("Deployment completed successfully!");
