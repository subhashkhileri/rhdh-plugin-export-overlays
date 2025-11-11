import { $ } from "@e2e-test-utils/bash";

// $.verbose = false;
// $.stdio = 'inherit'; // This makes all commands output directly to stdout
// $.prefix = "set -x;"

type Installation = {
    version: string;
    namespace: string;
    configmap: string;
    secrets: string;
    dynamicPlugins: string;
} & (
    | { method: "helm"; valueFile: string }
    | { method: "operator"; subscription: string }
);

class RHDHDeployment {
    private namespace: string;
    private version: string;
    public RHDH_BASE_URL: string;
    public incrementalNumber: number;

    constructor(installation: Installation) {
        this.namespace = installation.namespace;
        this.version = installation.version;
        this.RHDH_BASE_URL = installation.method === "helm" ? `https://redhat-developer-hub-${this.namespace}.${process.env.K8S_CLUSTER_ROUTER_BASE}` : `https://backstage-developer-hub-${this.namespace}.${process.env.K8S_CLUSTER_ROUTER_BASE}`;
        process.env.RHDH_BASE_URL = this.RHDH_BASE_URL;
        this.incrementalNumber = Math.floor(Math.random() * 1000000);
        console.log("RHDH deployment instance created");
    }
    async appConfig() {
        await $`oc create configmap app-config-rhdh \
            --from-file="config/app-config-rhdh.yaml" \
            --namespace="${this.namespace}" \
            --dry-run=client -o yaml | oc apply -f - --namespace="${this.namespace}"`;
    }
    async secrets() {
        await $`envsubst < config/rhdh-secrets.yaml | oc apply -f - --namespace="${this.namespace}"`;
    }
    async dynamicPlugins() {
        await $`oc create configmap dynamic-plugins \
            --from-file="config/dynamic-plugins.yaml" \
            --namespace="${this.namespace}" \
            --dry-run=client -o yaml | oc apply -f - --namespace="${this.namespace}"`;
    }
    async deploy() {
        // await this.appConfig();
        // await this.secrets();
        // await this.dynamicPlugins();
        await $`echo "testing zx logs ${process.env.K8S_CLUSTER_ROUTER_BASE}"`;
        console.log("deploying rhdh in namespace", this.namespace);
    }
    async getIncrementalNumber() {
        return this.incrementalNumber;
    }
    async setIncrementalNumber(incrementalNumber: number) {
        this.incrementalNumber = incrementalNumber;
    }
    async cleanup() {
        console.log("cleaning up rhdh deployment in namespace", this.namespace);
    }
}

export { RHDHDeployment };