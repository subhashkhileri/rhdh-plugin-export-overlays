import { $ } from "zx";
import * as k8s from "@kubernetes/client-node";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

$.verbose = true;

/**
 * Kubernetes client wrapper with proper abstraction
 */
class KubernetesClient {
  private kc: k8s.KubeConfig;
  private k8sApi: k8s.CoreV1Api;

  constructor() {
    this.kc = new k8s.KubeConfig();
    this.kc.loadFromDefault();
    this.k8sApi = this.kc.makeApiClient(k8s.CoreV1Api);
  }

  /**
   * Create or update a ConfigMap from a file
   */
  async createOrUpdateConfigMap(
    name: string,
    namespace: string,
    configFilePath: string,
    dataKey?: string
  ): Promise<k8s.V1ConfigMap> {
    try {
      const fileContent = fs.readFileSync(configFilePath, "utf-8");
      const key = dataKey || path.basename(configFilePath);

      const configMap: k8s.V1ConfigMap = {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: {
          name,
          namespace,
        },
        data: {
          [key]: fileContent,
        },
      };

      // Try to update first
      try {
        const response = await this.k8sApi.replaceNamespacedConfigMap({
          name,
          namespace,
          body: configMap,
        });
        console.log(`✓ Updated ConfigMap ${name} in namespace ${namespace}`);
        return response;
      } catch (error: any) {
        // If not found, create it
        if (error.statusCode === 404) {
          const response = await this.k8sApi.createNamespacedConfigMap({
            namespace,
            body: configMap,
          });
          console.log(`✓ Created ConfigMap ${name} in namespace ${namespace}`);
          return response;
        }
        throw error;
      }
    } catch (error: any) {
      console.error(
        `✗ Failed to create/update ConfigMap ${name}:`,
        error.message
      );
      throw error;
    }
  }

  /**
   * Create a namespace if it doesn't exist
   */
  async createNamespaceIfNotExists(
    namespace: string
  ): Promise<k8s.V1Namespace> {
    try {
      const response = await this.k8sApi.readNamespace({ name: namespace });
      console.log(`✓ Namespace ${namespace} already exists`);
      return response;
    } catch (error: any) {
      if (error.statusCode === 404) {
        const namespaceObj: k8s.V1Namespace = {
          apiVersion: "v1",
          kind: "Namespace",
          metadata: {
            name: namespace,
          },
        };
        const response = await this.k8sApi.createNamespace({
          body: namespaceObj,
        });
        console.log(`✓ Created namespace ${namespace}`);
        return response;
      }
      throw error;
    }
  }

  /**
   * Apply a Kubernetes manifest from a YAML file
   */
  async applyManifest(filePath: string, namespace: string): Promise<void> {
    try {
      const fileContent = fs.readFileSync(filePath, "utf-8");
      const docs = yaml.loadAll(fileContent) as any[];

      for (const doc of docs) {
        if (!doc || !doc.kind) continue;

        doc.metadata = doc.metadata || {};
        doc.metadata.namespace = namespace;

        await this.applyResource(doc, namespace);
      }
    } catch (error: any) {
      console.error(`✗ Failed to apply manifest ${filePath}:`, error.message);
      throw error;
    }
  }
  /**
   * Apply a Kubernetes resource dynamically
   */
  private async applyResource(resource: any, namespace: string): Promise<void> {
    const kind = resource.kind;
    const name = resource.metadata.name;

    try {
      switch (kind) {
        case "Secret":
          await this.applySecret(resource, namespace);
          break;
        case "ConfigMap":
          await this.applyConfigMapFromObject(resource, namespace);
          break;
        default:
          console.warn(`⚠ Skipping unsupported resource type: ${kind}`);
      }
    } catch (error: any) {
      console.error(`✗ Failed to apply ${kind} ${name}:`, error.message);
      throw error;
    }
  }

  /**
   * Create or update a Secret
   */
  private async applySecret(
    secret: k8s.V1Secret,
    namespace: string
  ): Promise<void> {
    const name = secret.metadata!.name!;
    try {
      await this.k8sApi.replaceNamespacedSecret({
        name,
        namespace,
        body: secret,
      });
      console.log(`✓ Updated Secret ${name} in namespace ${namespace}`);
    } catch (error: any) {
      if (error.statusCode === 404) {
        await this.k8sApi.createNamespacedSecret({
          namespace,
          body: secret,
        });
        console.log(`✓ Created Secret ${name} in namespace ${namespace}`);
      } else {
        throw error;
      }
    }
  }

  /**
   * Create or update a ConfigMap from an object
   */
  private async applyConfigMapFromObject(
    configMap: k8s.V1ConfigMap,
    namespace: string
  ): Promise<void> {
    const name = configMap.metadata!.name!;
    try {
      await this.k8sApi.replaceNamespacedConfigMap({
        name,
        namespace,
        body: configMap,
      });
      console.log(`✓ Updated ConfigMap ${name} in namespace ${namespace}`);
    } catch (error: any) {
      if (error.statusCode === 404) {
        await this.k8sApi.createNamespacedConfigMap({
          namespace,
          body: configMap,
        });
        console.log(`✓ Created ConfigMap ${name} in namespace ${namespace}`);
      } else {
        throw error;
      }
    }
  }

  /**
   * Delete a namespace
   */
  async deleteNamespace(namespace: string): Promise<void> {
    try {
      await this.k8sApi.deleteNamespace({ name: namespace });
      console.log(`✓ Deleted namespace ${namespace}`);
    } catch (error: any) {
      if (error.statusCode !== 404) {
        console.error(
          `✗ Failed to delete namespace ${namespace}:`,
          error.message
        );
        throw error;
      }
    }
  }
}

export { KubernetesClient };
