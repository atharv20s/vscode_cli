/**
 * ATH IDE — AWS Cloud Provisioner
 * Deploys Lightsail instance, static IP, private S3 snapshot bucket, and IAM worker credentials.
 */

import {
  S3Client,
  CreateBucketCommand,
  PutBucketVersioningCommand,
  PutPublicAccessBlockCommand
} from "@aws-sdk/client-s3";

import {
  IAMClient,
  CreateUserCommand,
  CreatePolicyCommand,
  AttachUserPolicyCommand,
  CreateAccessKeyCommand,
  ListAccessKeysCommand
} from "@aws-sdk/client-iam";

import {
  LightsailClient,
  CreateInstancesCommand,
  GetInstanceCommand,
  AllocateStaticIpCommand,
  AttachStaticIpCommand,
  CreateKeyPairCommand,
  GetKeyPairCommand,
  OpenInstancePublicPortsCommand
} from "@aws-sdk/client-lightsail";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REGION = "ap-south-1";
const BUCKET_NAME = "ath-ide-workspace-snapshots-758371668629";
const INSTANCE_NAME = "ath-ide-worker-01";
const STATIC_IP_NAME = "ath-ide-public-ip";
const KEY_PAIR_NAME = "ath-ide-key";

const s3 = new S3Client({ region: REGION });
const iam = new IAMClient({ region: "aws-global" });
const ls = new LightsailClient({ region: REGION });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log("===============================================================");
  console.log("🚀 ATH IDE — AWS Cloud Provisioning & Deployment");
  console.log(`   Region:    ${REGION} (Mumbai)`);
  console.log(`   Budget:    $12.00/mo Lightsail Bundle (small_3_1)`);
  console.log(`   Storage:   Private S3 (${BUCKET_NAME})`);
  console.log("===============================================================\n");

  // -------------------------------------------------------------
  // 1. S3 Snapshot Bucket Setup
  // -------------------------------------------------------------
  console.log("📦 1. Setting up S3 Workspace Snapshot Bucket...");
  try {
    await s3.send(new CreateBucketCommand({
      Bucket: BUCKET_NAME,
      CreateBucketConfiguration: { LocationConstraint: REGION }
    }));
    console.log(`   ✅ S3 bucket created: ${BUCKET_NAME}`);
  } catch (err) {
    if (err.name === "BucketAlreadyOwnedByYou" || err.name === "BucketAlreadyExists") {
      console.log(`   ℹ️ Bucket ${BUCKET_NAME} already exists.`);
    } else {
      throw err;
    }
  }

  console.log("   🔒 Enforcing Public Access Block (Private)...");
  await s3.send(new PutPublicAccessBlockCommand({
    Bucket: BUCKET_NAME,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true
    }
  }));

  console.log("   🔄 Enabling S3 Object Versioning...");
  await s3.send(new PutBucketVersioningCommand({
    Bucket: BUCKET_NAME,
    VersioningConfiguration: { Status: "Enabled" }
  }));
  console.log("   ✅ S3 Bucket secured with private access block and versioning.");

  // -------------------------------------------------------------
  // 2. IAM Worker Identity & Snapshot Policy
  // -------------------------------------------------------------
  console.log("\n🔑 2. Configuring Dedicated IAM Worker Identity...");
  let workerUserCreated = false;
  try {
    await iam.send(new CreateUserCommand({ UserName: "AthIdeWorkspaceWorker" }));
    console.log("   ✅ Created IAM user: AthIdeWorkspaceWorker");
    workerUserCreated = true;
  } catch (err) {
    if (err.name === "EntityAlreadyExistsException") {
      console.log("   ℹ️ IAM user AthIdeWorkspaceWorker already exists.");
    } else {
      throw err;
    }
  }

  const policyDoc = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "s3:PutObject",
          "s3:GetObject",
          "s3:ListBucket",
          "s3:DeleteObject",
          "s3:GetObjectVersion"
        ],
        Resource: [
          `arn:aws:s3:::${BUCKET_NAME}`,
          `arn:aws:s3:::${BUCKET_NAME}/*`
        ]
      }
    ]
  };

  let policyArn = "arn:aws:iam::758371668629:policy/AthIdeWorkspaceSnapshotPolicy";
  try {
    const pRes = await iam.send(new CreatePolicyCommand({
      PolicyName: "AthIdeWorkspaceSnapshotPolicy",
      PolicyDocument: JSON.stringify(policyDoc)
    }));
    policyArn = pRes.Policy.Arn;
    console.log(`   ✅ Policy created: ${policyArn}`);
  } catch (err) {
    if (err.name === "EntityAlreadyExistsException") {
      console.log(`   ℹ️ Policy already exists: ${policyArn}`);
    } else {
      throw err;
    }
  }

  try {
    await iam.send(new AttachUserPolicyCommand({
      UserName: "AthIdeWorkspaceWorker",
      PolicyArn: policyArn
    }));
    console.log("   ✅ Attached AthIdeWorkspaceSnapshotPolicy to AthIdeWorkspaceWorker.");
  } catch (err) {
    console.log("   ℹ️ Attach policy notice:", err.message);
  }

  let workerCreds = null;
  const existingKeys = await iam.send(new ListAccessKeysCommand({ UserName: "AthIdeWorkspaceWorker" }));
  if (existingKeys.AccessKeyMetadata && existingKeys.AccessKeyMetadata.length > 0) {
    console.log(`   ℹ️ Access key exists for AthIdeWorkspaceWorker (${existingKeys.AccessKeyMetadata[0].AccessKeyId})`);
  } else {
    const kRes = await iam.send(new CreateAccessKeyCommand({ UserName: "AthIdeWorkspaceWorker" }));
    workerCreds = {
      accessKeyId: kRes.AccessKey.AccessKeyId,
      secretAccessKey: kRes.AccessKey.SecretAccessKey
    };
    console.log(`   ✅ Generated worker access key: ${workerCreds.accessKeyId}`);
    fs.writeFileSync(
      path.resolve(__dirname, "../server/.worker_s3_creds.json"),
      JSON.stringify(workerCreds, null, 2)
    );
  }

  // -------------------------------------------------------------
  // 3. Lightsail SSH Key Pair
  // -------------------------------------------------------------
  console.log("\n🔐 3. Setting up Lightsail SSH Key Pair...");
  const keyPath = path.resolve(__dirname, "../ath-ide-key.pem");
  try {
    const keyRes = await ls.send(new CreateKeyPairCommand({ keyPairName: KEY_PAIR_NAME }));
    fs.writeFileSync(keyPath, keyRes.privateKeyBase64, "utf8");
    console.log(`   ✅ Created and saved SSH key to: ${keyPath}`);
  } catch (err) {
    console.log(`   ℹ️ Key pair ${KEY_PAIR_NAME} notice: ${err.message}`);
  }

  // -------------------------------------------------------------
  // 4. Lightsail Instance Provisioning ($12/mo small_3_1)
  // -------------------------------------------------------------
  console.log("\n⚡ 4. Provisioning Lightsail Instance (ath-ide-worker-01)...");
  const userData = `#!/bin/bash
set -e
echo "Starting ATH IDE cloud bootstrap..." > /var/log/ath-ide-bootstrap.log

# 1. 2 GB Swap
fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# 2. Prerequisites
export DEBIAN_FRONTEND=noninteractive
apt-get update && apt-get install -y ca-certificates curl gnupg git ufw fail2ban jq

# 3. Docker Engine & Compose
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable docker
systemctl start docker
usermod -aG docker ubuntu

# 4. Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# 5. Directories
mkdir -p /var/lib/ath-ide/worker /var/lib/ath-ide/repo-agent-workspaces /var/lib/ath-ide/data /var/lib/ath-ide/app
chown -R ubuntu:ubuntu /var/lib/ath-ide

# 6. Firewall
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3001/tcp
ufw allow 8081/tcp
ufw --force enable

echo "Bootstrap completed successfully: $(date)" >> /var/log/ath-ide-bootstrap.log
`;

  let instanceExists = false;
  try {
    const inst = await ls.send(new GetInstanceCommand({ instanceName: INSTANCE_NAME }));
    if (inst.instance) {
      instanceExists = true;
      console.log(`   ℹ️ Instance ${INSTANCE_NAME} already exists (State: ${inst.instance.state.name}).`);
    }
  } catch {}

  if (!instanceExists) {
    await ls.send(new CreateInstancesCommand({
      instanceNames: [INSTANCE_NAME],
      availabilityZone: `${REGION}a`,
      blueprintId: "ubuntu_24_04",
      bundleId: "small_3_1",
      keyPairName: KEY_PAIR_NAME,
      userData
    }));
    console.log(`   ✅ Instance ${INSTANCE_NAME} launched! (Bundle: small_3_1, 2 vCPUs, 2 GB RAM, 60 GB SSD)`);
  }

  // -------------------------------------------------------------
  // 5. Open Firewall Ports in Lightsail
  // -------------------------------------------------------------
  console.log("\n🛡️ 5. Configuring Lightsail Network Firewall...");
  const ports = [
    { fromPort: 22, toPort: 22, protocol: "tcp" },
    { fromPort: 80, toPort: 80, protocol: "tcp" },
    { fromPort: 443, toPort: 443, protocol: "tcp" },
    { fromPort: 3001, toPort: 3001, protocol: "tcp" },
    { fromPort: 8081, toPort: 8081, protocol: "tcp" }
  ];

  for (const p of ports) {
    try {
      await ls.send(new OpenInstancePublicPortsCommand({
        instanceName: INSTANCE_NAME,
        portInfo: p
      }));
    } catch {}
  }
  console.log("   ✅ Allowed TCP ports: 22 (SSH), 80 (HTTP), 443 (HTTPS), 3001 (Web Studio), 8081 (Worker)");

  // -------------------------------------------------------------
  // 6. Allocate & Attach Static Public IP
  // -------------------------------------------------------------
  console.log("\n🌐 6. Allocating and Attaching Static Public IP...");
  let publicIp = null;
  try {
    const ipRes = await ls.send(new AllocateStaticIpCommand({ staticIpName: STATIC_IP_NAME }));
    publicIp = ipRes.operations?.[0]?.resourceName;
    console.log(`   ✅ Allocated static IP: ${STATIC_IP_NAME}`);
  } catch (err) {
    console.log(`   ℹ️ Static IP notice: ${err.message}`);
  }

  // Wait for instance to become running before attaching
  process.stdout.write("   ⏳ Waiting for instance to enter 'running' state... ");
  let running = false;
  for (let i = 0; i < 30; i++) {
    const check = await ls.send(new GetInstanceCommand({ instanceName: INSTANCE_NAME }));
    if (check.instance?.state?.name === "running") {
      running = true;
      publicIp = check.instance.publicIpAddress;
      break;
    }
    process.stdout.write(".");
    await sleep(4000);
  }
  console.log(" Running!");

  try {
    await ls.send(new AttachStaticIpCommand({
      instanceName: INSTANCE_NAME,
      staticIpName: STATIC_IP_NAME
    }));
    console.log(`   ✅ Attached ${STATIC_IP_NAME} to ${INSTANCE_NAME}.`);
  } catch (err) {
    console.log(`   ℹ️ Attach IP notice: ${err.message}`);
  }

  const finalCheck = await ls.send(new GetInstanceCommand({ instanceName: INSTANCE_NAME }));
  const finalIp = finalCheck.instance?.publicIpAddress || publicIp;

  console.log("\n===============================================================");
  console.log("🎉 ATH IDE — AWS CLOUD INFRASTRUCTURE PROVISIONED!");
  console.log("===============================================================");
  console.log(`   Static Public IP:  ${finalIp}`);
  console.log(`   Web Studio URL:    http://${finalIp}:3001`);
  console.log(`   Execution Worker:  http://${finalIp}:8081`);
  console.log(`   SSH Access:        ssh -i "${keyPath}" ubuntu@${finalIp}`);
  console.log(`   S3 Snapshot Store: s3://${BUCKET_NAME}`);
  console.log(`   Monthly Cost:      $12.00/month (Lightsail small_3_1)`);
  console.log("===============================================================\n");
}

main().catch((err) => {
  console.error("\n❌ PROVISIONING ERROR:", err);
  process.exit(1);
});

