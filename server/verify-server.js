async function verify() {
  console.log("Testing Health Endpoint...");
  try {
    const res = await fetch("http://127.0.0.1:3001/api/health");
    const data = await res.json();
    console.log("Health check response:", data);

    console.log("Testing Models Endpoint...");
    const modelsRes = await fetch("http://127.0.0.1:3001/api/agent/models");
    const modelsData = await modelsRes.json();
    console.log("Available models count:", modelsData.models?.length);

    console.log("Testing Workspace Files Endpoint...");
    const filesRes = await fetch("http://127.0.0.1:3001/api/workspace/files");
    const filesData = await filesRes.json();
    console.log("Workspace files:", filesData.entries?.map(e => e.name));

    console.log("\n✅ ALL VERIFICATION CHECKS PASSED!");
    process.exit(0);
  } catch (err) {
    console.error("Verification failed:", err);
    process.exit(1);
  }
}

verify();
