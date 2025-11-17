import { $ } from "@e2e-test-utils/utils/bash";
import { KubernetesClient } from "@e2e-test-utils/helpers/kubernetes-client";
import { mergeYamlFilesIfExists } from "@e2e-test-utils/utils/merge-yamls";
import { envsubst } from "@e2e-test-utils/utils/common";
import fs from "fs-extra";
import yaml from "js-yaml";
import { test } from "@playwright/test";

$.prefix = "source e2e-test-utils/rhdh-deployment/utils/utils.sh;";

const BASE_CONFIG = {
  appConfig: "e2e-test-utils/rhdh-deployment/config/app-config-rhdh.yaml",
  secrets: "e2e-test-utils/rhdh-deployment/config/rhdh-secrets.yaml",
  dynamicPlugins: "e2e-test-utils/rhdh-deployment/config/dynamic-plugins.yaml",
  helm: {
    valueFile: "e2e-test-utils/rhdh-deployment/helm/value_file.yaml",
  },
  operator: {
    subscription: "e2e-test-utils/rhdh-deployment/operator/subscription.yaml",
  },
} as const;

type DeploymentMethod = "helm" | "operator";

type InstallationInput = {
  version?: string;
  namespace: string;
  appConfig?: string;
  secrets?: string;
  dynamicPlugins?: string;
  method?: DeploymentMethod;
  valueFile?: string;
  subscription?: string;
};

type HelmInstallation = {
  method: "helm";
  valueFile: string;
};

type OperatorInstallation = {
  method: "operator";
  subscription: string;
};

type InstallationBase = {
  version: string;
  namespace: string;
  appConfig: string;
  secrets: string;
  dynamicPlugins: string;
};

type Installation = InstallationBase &
  (HelmInstallation | OperatorInstallation);

export class RHDHDeployment {
  public k8sClient = new KubernetesClient();
  public RHDH_BASE_URL: string;
  public installation: Installation;

  constructor(input: InstallationInput) {
    this.installation = this.normalizeInstallation(input);
    this.RHDH_BASE_URL = this.buildBaseUrl(this.installation);
    this.log(
      `RHDH deployment initialized (namespace: ${this.installation.namespace})`
    );
    console.table(this.installation);
  }

  async deploy(): Promise<void> {
    this.log("Starting RHDH deployment...");

    test.setTimeout(300_000);

    // // Create namespace first
    // await $`kubectl create namespace ${this.installation.namespace} || echo "Namespace ${this.installation.namespace} already exists and will be used"`;

    // await this.applyAppConfig();
    // await this.applySecrets();

    // if (this.installation.method === "helm") {
    //   await this.deployWithHelm(this.installation.valueFile);
    // } else {
    //   await this.applyDynamicPlugins();
    //   await this.deployWithOperator(this.installation.subscription);
    // }
    // await this.waitUntilReady();
  }

  private async applyAppConfig(): Promise<void> {
    const appConfigYaml = await mergeYamlFilesIfExists([
      BASE_CONFIG.appConfig,
      this.installation.appConfig,
    ]);

    await this.k8sClient.applyConfigMapFromObject(
      "app-config-rhdh",
      appConfigYaml,
      this.installation.namespace
    );
  }

  private async applySecrets(): Promise<void> {
    const secretsYaml = await mergeYamlFilesIfExists([
      BASE_CONFIG.secrets,
      this.installation.secrets,
    ]);

    await this.k8sClient.applySecretFromObject(
      "rhdh-secrets",
      JSON.parse(envsubst(JSON.stringify(secretsYaml))),
      this.installation.namespace
    );
  }

  private async applyDynamicPlugins(): Promise<void> {
    const dynamicPluginsYaml = await mergeYamlFilesIfExists([
      BASE_CONFIG.dynamicPlugins,
      this.installation.dynamicPlugins,
    ]);
    await this.k8sClient.applyConfigMapFromObject(
      "dynamic-plugins",
      dynamicPluginsYaml,
      this.installation.namespace
    );
  }

  private async deployWithHelm(valueFile: string): Promise<void> {
    const chartVersion = await this.resolveChartVersion(
      this.installation.version
    );
    const valueFileObject = await mergeYamlFilesIfExists([
      BASE_CONFIG.helm.valueFile,
      valueFile,
    ]);

    // Merge dynamic plugins into the values file
    if (!valueFileObject.global) {
      valueFileObject.global = {};
    }
    valueFileObject.global.dynamic = await mergeYamlFilesIfExists([
      BASE_CONFIG.dynamicPlugins,
      this.installation.dynamicPlugins,
    ]);

    fs.writeFileSync(
      `/tmp/${this.installation.namespace}-value-file.yaml`,
      yaml.dump(valueFileObject)
    );

    const helmCommand = await $`
      helm upgrade redhat-developer-hub -i "${process.env.CHART_URL}" --version "${chartVersion}" \
        -f "/tmp/${this.installation.namespace}-value-file.yaml" \
        --set global.clusterRouterBase="${process.env.K8S_CLUSTER_ROUTER_BASE}" \
        --namespace="${this.installation.namespace}"
    `;

    this.log(`Helm deployment executed: ${helmCommand.stdout.trim()}`);
  }

  private async deployWithOperator(subscription: string): Promise<void> {
    const subscriptionObject = await mergeYamlFilesIfExists([
      BASE_CONFIG.operator.subscription,
      subscription,
    ]);
    fs.writeFileSync(
      `/tmp/${this.installation.namespace}-subscription.yaml`,
      yaml.dump(subscriptionObject)
    );
    await $`
      set -e;
      curl -s https://raw.githubusercontent.com/redhat-developer/rhdh-operator/refs/heads/release-${this.installation.version}/.rhdh/scripts/install-rhdh-catalog-source.sh | bash -s -- -v ${this.installation.version} --install-operator rhdh

      timeout 300 bash -c '
        while ! oc get crd/backstages.rhdh.redhat.com -n "${this.installation.namespace}" >/dev/null 2>&1; do
          echo "Waiting for Backstage CRD to be created..."
          sleep 20
        done
        echo "Backstage CRD is created."
      ' || echo "Error: Timed out waiting for Backstage CRD creation."

      oc apply -f "/tmp/${this.installation.namespace}-subscription.yaml" -n "${this.installation.namespace}"
    `;

    this.log("Operator deployment executed successfully.");
  }

  async restartRollout(): Promise<void> {
    this.log(
      `Restarting RHDH deployment in namespace ${this.installation.namespace}...`
    );
    await $`oc rollout restart deployment -l app.kubernetes.io/instance=redhat-developer-hub -n ${this.installation.namespace}`;
    this.log(
      `RHDH deployment restarted successfully in namespace ${this.installation.namespace}`
    );
    await this.waitUntilReady();
  }

  async waitUntilReady(timeout: number = 300): Promise<void> {
    this.log(
      `Waiting for RHDH deployment to be ready in namespace ${this.installation.namespace}...`
    );
    await $`oc rollout status deployment -l app.kubernetes.io/instance=redhat-developer-hub -n ${this.installation.namespace} --timeout=${timeout}s`;
    this.log(
      `RHDH deployment is ready in namespace ${this.installation.namespace}`
    );
  }

  async destroy(): Promise<void> {
    await this.k8sClient.deleteNamespace(this.installation.namespace);
  }

  private async resolveChartVersion(version: string): Promise<string> {
    // Semantic versions (e.g., 1.2)
    if (/^(\d+(\.\d+)?)$/.test(version)) {
      const response = await fetch(
        "https://quay.io/api/v1/repository/rhdh/chart/tag/?onlyActiveTags=true&limit=600"
      );

      if (!response.ok)
        throw new Error(
          `Failed to fetch chart versions: ${response.statusText}`
        );

      const data = (await response.json()) as { tags: Array<{ name: string }> };
      const matching = data.tags
        .map((t) => t.name)
        .filter((name) => name.startsWith(`${version}-`))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

      const latest = matching.at(-1);
      if (!latest) throw new Error(`No chart version found for ${version}`);
      return latest;
    }

    // CI build versions (e.g., 1.2.3-CI)
    if (version.endsWith("CI")) return version;

    throw new Error(`Invalid Helm chart version format: "${version}"`);
  }

  private normalizeInstallation(input: InstallationInput): Installation {
    const version = input.version ?? process.env.RHDH_VERSION;
    const method =
      input.method ?? (process.env.INSTALLATION_METHOD as DeploymentMethod);

    if (!version) throw new Error("RHDH version is required");
    if (!method)
      throw new Error("Installation method (helm/operator) is required");

    const base: InstallationBase = {
      version,
      namespace: input.namespace,
      appConfig:
        input.appConfig ??
        `workspaces/${input.namespace}/e2e/config/app-config-rhdh.yaml`,
      secrets:
        input.secrets ??
        `workspaces/${input.namespace}/e2e/config/rhdh-secrets.yaml`,
      dynamicPlugins:
        input.dynamicPlugins ??
        `workspaces/${input.namespace}/e2e/config/dynamic-plugins.yaml`,
    };

    if (method === "helm") {
      return {
        ...base,
        method,
        valueFile:
          input.valueFile ??
          `workspaces/${input.namespace}/e2e/config/value_file.yaml`,
      };
    } else if (method === "operator") {
      return {
        ...base,
        method,
        subscription:
          input.subscription ??
          `workspaces/${input.namespace}/e2e/config/subscription.yaml`,
      };
    } else {
      throw new Error(`Invalid RHDH installation method: ${method}`);
    }
  }

  async overrideInstallation(input: InstallationInput): Promise<void> {
    this.installation = this.normalizeInstallation(input);
    this.RHDH_BASE_URL = this.buildBaseUrl(this.installation);
    this.log(
      `RHDH deployment initialized (namespace: ${this.installation.namespace})`
    );
    console.table(this.installation);
  }

  private buildBaseUrl(install: Installation): string {
    const prefix =
      install.method === "helm"
        ? "redhat-developer-hub"
        : "backstage-developer-hub";
    return `https://${prefix}-${install.namespace}.${process.env.K8S_CLUSTER_ROUTER_BASE}`;
  }

  private log(...args: unknown[]): void {
    console.log("[RHDHDeployment]", ...args);
  }

  async saveLogs(): Promise<void> {
    await $`save_all_pod_logs "${this.installation.namespace}"`;
    this.log("RHDH logs saved successfully.");
  }
}
