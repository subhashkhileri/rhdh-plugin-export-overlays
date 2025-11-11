import { $ } from "zx";
$.verbose = true;

// Use this guide to deploy Keycloak on OpenShift:
//https://www.keycloak.org/getting-started/getting-started-openshift
//https://www.npmjs.com/package/@keycloak/keycloak-admin-client

const NAMESPACE = "rhdh-keycloak";
const ROUTE_NAME = "keycloak";

async function getKeycloakUrl(routerBase: string): Promise<string> {
  return `http://${ROUTE_NAME}-${NAMESPACE}.${routerBase}`;
}

async function isKeycloakLive(keycloakUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${keycloakUrl}/realms/rhdh`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function deployKeycloak(): Promise<void> {
  try {
    console.log("Deploying Keycloak...");
    await $`./e2e/common/utils/keycloak/keycloak-deploy.sh ${NAMESPACE} ${ROUTE_NAME}`;
  } catch (error) {
    console.error("Error deploying Keycloak:", error);
    throw error;
  }
}

async function deleteKeycloak(): Promise<void> {
  try {
    console.log("Deleting Keycloak...");
    await $`kubectl delete namespace ${NAMESPACE}`;
  } catch (error) {
    console.error("Error deleting Keycloak:", error);
    throw error;
  }
}
export { getKeycloakUrl, isKeycloakLive, deployKeycloak };
