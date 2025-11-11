import { $ } from "@e2e-test-utils/bash";

import {
  deployKeycloak,
  getKeycloakUrl,
  isKeycloakLive,
} from "@e2e-test-utils/keycloak";

async function getClusterRouterBase(): Promise<string> {
  try {
    const consoleHost =
      await $`kubectl get route console -n openshift-console -o=jsonpath='{.spec.host}'`;
    const routerBase =
      await $`echo ${consoleHost.stdout.trim()} | sed 's/^[^.]*\\.//'`;
    return routerBase.stdout.trim();
  } catch (error) {
    throw new Error(`Failed to get cluster router base: ${error}`);
  }
}

function setEnvironmentVariables(
  keycloakUrl: string,
  routerBase: string
): void {
  process.env.K8S_CLUSTER_ROUTER_BASE = routerBase;
  process.env.KEYCLOAK_CLIENT_SECRET = "rhdh-client-secret";
  process.env.KEYCLOAK_CLIENT_ID = "rhdh-client";
  process.env.KEYCLOAK_REALM = "rhdh";
  process.env.KEYCLOAK_LOGIN_REALM = "rhdh";
  process.env.KEYCLOAK_METADATA_URL = `${keycloakUrl}/realms/rhdh`;
  process.env.KEYCLOAK_BASE_URL = keycloakUrl;
}

async function main(): Promise<void> {
  const routerBase = await getClusterRouterBase();
  const keycloakUrl = await getKeycloakUrl(routerBase);

  const isLive = await isKeycloakLive(keycloakUrl);

  if (!isLive) {
    // await deployKeycloak();
  } else {
    console.log(
      "Keycloak deployment already exists and is live, skipping deployment"
    );
  }
  setEnvironmentVariables(keycloakUrl, routerBase);
}

export default async () => await main();
