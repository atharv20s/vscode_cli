#!/usr/bin/env ruby
require "yaml"

root = File.expand_path("..", __dir__)
load_yaml = lambda do |relative|
  path = File.join(root, relative)
  docs = YAML.load_stream(File.read(path))
  docs.compact
rescue Psych::Exception => error
  abort "Invalid YAML in #{relative}: #{error.message}"
end

namespace = load_yaml.call("k8s/namespace.yaml").find { |doc| doc["kind"] == "Namespace" }
abort "Namespace must enforce restricted Pod Security Standards" unless namespace &&
  namespace.dig("metadata", "labels", "pod-security.kubernetes.io/enforce") == "restricted"

deployment = load_yaml.call("k8s/deployment.yaml").find { |doc| doc["kind"] == "Deployment" }
abort "Deployment manifest missing" unless deployment
pod = deployment.dig("spec", "template", "spec")
pod_security = pod && pod["securityContext"]
abort "Pod must run non-root" unless pod_security && pod_security["runAsNonRoot"] == true
abort "Pod must use RuntimeDefault seccomp" unless pod_security.dig("seccompProfile", "type") == "RuntimeDefault"
containers = pod.fetch("containers", [])
abort "Expected at least one application container" if containers.empty?

containers.each do |container|
  security = container["securityContext"] || {}
  abort "#{container["name"]}: privilege escalation must be disabled" unless security["allowPrivilegeEscalation"] == false
  abort "#{container["name"]}: root filesystem must be read-only" unless security["readOnlyRootFilesystem"] == true
  abort "#{container["name"]}: privileged mode is forbidden" unless security["privileged"] == false
  abort "#{container["name"]}: all Linux capabilities must be dropped" unless Array(security.dig("capabilities", "drop")).include?("ALL")
  mounts = Array(container["volumeMounts"])
  abort "#{container["name"]}: writable /tmp must be mounted separately" unless mounts.any? { |mount| mount["mountPath"] == "/tmp" && mount["name"] == "tmp-volume" }
end

service = load_yaml.call("k8s/deployment.yaml").find { |doc| doc["kind"] == "Service" && doc.dig("metadata", "name") == "ath-ide-service" }
abort "Backend Service must remain ClusterIP behind the Ingress" unless service && service.dig("spec", "type") == "ClusterIP"

pdb = load_yaml.call("k8s/pod-disruption-budget.yaml").find { |doc| doc["kind"] == "PodDisruptionBudget" }
abort "PodDisruptionBudget must preserve at least one backend replica" unless pdb && pdb.dig("spec", "minAvailable").to_i >= 1

tmp_volume = Array(pod["volumes"]).find { |volume| volume["name"] == "tmp-volume" }
abort "A bounded emptyDir must back /tmp" unless tmp_volume && tmp_volume.dig("emptyDir", "sizeLimit")
puts "Kubernetes security manifests validated: restricted namespace, non-root pod, RuntimeDefault seccomp, no privilege escalation, read-only rootfs, dropped capabilities and bounded /tmp."
