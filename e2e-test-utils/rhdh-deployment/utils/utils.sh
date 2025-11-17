#!/bin/bash

set -e
retrieve_pod_logs() {
  local pod_name=$1
  local container=$2
  local namespace=$3
  echo "  Retrieving logs for container: $container"
  # Save logs for the current and previous container
  kubectl logs $pod_name -c $container -n $namespace > "e2e-test-reports/$namespace/pod_logs/${pod_name}_${container}.log" || { echo "  logs for container $container not found"; }
  kubectl logs $pod_name -c $container -n $namespace --previous > "e2e-test-reports/$namespace/pod_logs/${pod_name}_${container}-previous.log" 2> /dev/null || {
    echo "  Previous logs for container $container not found"
    rm -f "e2e-test-reports/$namespace/pod_logs/${pod_name}_${container}-previous.log"
  }
}

save_all_pod_logs() {
  set +e
  local namespace=$1

  if [[ -z "$namespace" ]]; then
    echo "Namespace is required"
    return 1
  fi

  rm -rf e2e-test-reports/$namespace/pod_logs && mkdir -p e2e-test-reports/$namespace/pod_logs

  # Get all pod names in the namespace
  pod_names=$(kubectl get pods -n $namespace -o jsonpath='{.items[*].metadata.name}')
  for pod_name in $pod_names; do
    echo "Retrieving logs for pod: $pod_name in namespace $namespace"

    init_containers=$(kubectl get pod $pod_name -n $namespace -o jsonpath='{.spec.initContainers[*].name}')
    # Loop through each init container and retrieve logs
    for init_container in $init_containers; do
      retrieve_pod_logs $pod_name $init_container $namespace
    done

    containers=$(kubectl get pod $pod_name -n $namespace -o jsonpath='{.spec.containers[*].name}')
    for container in $containers; do
      retrieve_pod_logs $pod_name $container $namespace
    done
  done
  set -e
}