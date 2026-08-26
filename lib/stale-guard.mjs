// Pure decision logic for the push stale-state guard.
// No filesystem, no git, no state - everything comes in as plain data.
//
// The push mirrors the local vault into the remote. A device that never pulled
// would silently delete files it could not know about and revert others to older
// versions. This module decides whether that is about to happen.

// NTFS stores 100ns ticks while JS Date carries milliseconds, so a restored
// mtime reads back marginally different. FAT32 is granular to 2s. The pull uses
// the same tolerance for its delete check.
export const MTIME_TOLERANCE_MS = 2000;

/**
 * @returns {{deletions: Array, reversions: Array, unsafe: Array, blocked: boolean}}
 */
export function detectStalePush({ remoteFiles, localFiles, localMtimes, baseline, manifestVault, indexPath }) {
  const local = new Set(localFiles || []);
  const lm = localMtimes || {};
  const baseFiles = (baseline && baseline.files) || null;
  const mv = manifestVault || {};
  const idx = (indexPath || "").split(/[\\/]/).join("/");

  const deletions = [], reversions = [], unsafe = [];

  for (const rel of remoteFiles || []) {
    if (rel === idx) continue; // written by the push itself, never a real divergence

    const remoteRec = mv[rel];

    if (!local.has(rel)) {
      // the file would vanish from the remote
      if (!baseFiles || !(rel in baseFiles)) {
        deletions.push({ rel, grund: "nie-gepullt" });
      } else if (!remoteRec || typeof remoteRec.mtime !== "number") {
        // in baseline, but no manifest record -> cannot tell if remote changed since -> block
        unsafe.push({ rel, grund: "kein Manifest-Eintrag" });
      } else if (Math.abs(remoteRec.mtime - baseFiles[rel]) > MTIME_TOLERANCE_MS) {
        // we last saw an older version; someone changed it since -> not our call
        deletions.push({ rel, grund: "remote-geaendert" });
      }
      continue;
    }

    // the file exists locally and would overwrite the remote copy
    if (!remoteRec || typeof remoteRec.mtime !== "number") {
      unsafe.push({ rel, grund: "kein Manifest-Eintrag" });
      continue;
    }
    const localMtime = rel in lm ? lm[rel] : null;
    if (localMtime === null) {
      // failed stat leaves the file listed but without an mtime -> cannot confirm safety -> block
      unsafe.push({ rel, grund: "keine lokale mtime" });
    } else if (localMtime < remoteRec.mtime - MTIME_TOLERANCE_MS) {
      reversions.push({ rel, localMtime, remoteMtime: remoteRec.mtime });
    }
  }

  return { deletions, reversions, unsafe, blocked: !!(deletions.length || reversions.length || unsafe.length) };
}

export function formatStaleReport(r) {
  const lines = ["", "Push ABGEBROCHEN: dieses Geraet hat einen veralteten Stand.", ""];
  const list = (arr, fmt) => {
    for (const e of arr.slice(0, 25)) lines.push("    - " + fmt(e));
    if (arr.length > 25) lines.push(`    ... und ${arr.length - 25} weitere`);
  };
  if (r.deletions.length) {
    lines.push(`  ${r.deletions.length} Dateien wuerden GELOESCHT:`);
    list(r.deletions, (e) => `${e.rel}  (${e.grund})`);
    lines.push("");
  }
  if (r.reversions.length) {
    lines.push(`  ${r.reversions.length} Dateien wuerden ZURUECKGEDREHT (remote ist neuer):`);
    list(r.reversions, (e) => `${e.rel}  remote ${new Date(e.remoteMtime).toISOString()} > lokal ${new Date(e.localMtime).toISOString()}`);
    lines.push("");
  }
  if (r.unsafe.length) {
    lines.push(`  ${r.unsafe.length} Dateien mit unklarem Zustand:`);
    list(r.unsafe, (e) => `${e.rel}  (${e.grund})`);
    lines.push("");
  }
  lines.push("Optionen:");
  lines.push("  - erst 'brain pull', dann erneut pushen");
  lines.push("  - bewusst trotzdem pushen: --allow-stale");
  lines.push("");
  lines.push("(nichts wurde committet oder gepusht)");
  return lines.join("\n");
}
