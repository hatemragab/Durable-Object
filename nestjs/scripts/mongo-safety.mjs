import { realpath } from "node:fs/promises";

/** Initialize only this repository's uninitialized MongoDB process; never reconfigure a set. */
export async function ensureReplicaSetInitialized(admin, ownedPath, port) {
  const expectedPort = Number(port);
  if (
    !Number.isInteger(expectedPort) ||
    expectedPort < 1 ||
    expectedPort > 65535
  ) {
    throw new Error("An explicit valid MongoDB port is required.");
  }
  let status;
  try {
    status = await admin.command({ replSetGetStatus: 1 });
  } catch (error) {
    if (error.code !== 94) throw error;
  }
  if (status) {
    if (status.set !== "rs0")
      throw new Error(
        "Refusing a MongoDB replica set other than the dedicated rs0 set.",
      );
    return { initialized: false };
  }

  const options = await admin.command({ getCmdLineOpts: 1 });
  const actualPath = options.parsed?.storage?.dbPath;
  let ownsPath = false;
  if (typeof actualPath === "string") {
    try {
      ownsPath = (await realpath(actualPath)) === (await realpath(ownedPath));
    } catch {
      /* Fail closed when either path cannot be verified. */
    }
  }
  if (!ownsPath)
    throw new Error(
      "Refusing to initialize an unowned MongoDB server; the verified dbpath must belong to this repository.",
    );
  const replication = options.parsed?.replication;
  const configuredSet = replication?.replSetName ?? replication?.replSet;
  if (
    configuredSet !== "rs0" ||
    Number(options.parsed?.net?.port) !== expectedPort
  ) {
    throw new Error(
      "Refusing to initialize MongoDB with a different replica-set name or port.",
    );
  }
  await admin.command({
    replSetInitiate: {
      _id: "rs0",
      members: [{ _id: 0, host: `127.0.0.1:${expectedPort}` }],
    },
  });
  return { initialized: true };
}
