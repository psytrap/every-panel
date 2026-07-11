// scripts/check_version_timestamp.ts
const configPath = new URL("../deno.json", import.meta.url);

async function getMaxMtime(dirPath: string): Promise<Date> {
  let maxDate = new Date(0);
  try {
    for await (const entry of Deno.readDir(dirPath)) {
      const fullPath = `${dirPath}/${entry.name}`;
      if (entry.isDirectory) {
        const subMax = await getMaxMtime(fullPath);
        if (subMax > maxDate) maxDate = subMax;
      } else if (entry.isFile) {
        const stat = await Deno.stat(fullPath);
        if (stat.mtime && stat.mtime > maxDate) {
          maxDate = stat.mtime;
        }
      }
    }
  } catch {
    // Directory might not exist or be inaccessible
  }
  return maxDate;
}

try {
  const configText = await Deno.readTextFile(configPath);
  const config = JSON.parse(configText);
  const releaseDateStr = config.releaseDate;

  if (!releaseDateStr) {
    console.error("❌ Error: releaseDate is missing from deno.json!");
    Deno.exit(1);
  }

  // Parse YYYY-MM-DD HH:MM
  const match = releaseDateStr.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!match) {
    console.error(`❌ Error: releaseDate format must be 'YYYY-MM-DD HH:MM'. Found: '${releaseDateStr}'`);
    Deno.exit(1);
  }

  const [_, year, month, day, hours, minutes] = match;
  
  // Create local date object matching timezone configuration
  const releaseDate = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hours),
    Number(minutes)
  );

  // Scan project directories for latest file modification time
  const srcMax = await getMaxMtime("./src");
  const publicMax = await getMaxMtime("./public");
  const testsMax = await getMaxMtime("./tests");
  const maxMtime = new Date(Math.max(srcMax.getTime(), publicMax.getTime(), testsMax.getTime()));

  const pad = (n: number) => String(n).padStart(2, "0");
  const maxMtimeStr = `${maxMtime.getFullYear()}-${pad(maxMtime.getMonth() + 1)}-${pad(maxMtime.getDate())} ${pad(maxMtime.getHours())}:${pad(maxMtime.getMinutes())}`;

  console.log("--------------------------------------------------");
  console.log(`🔍 Version Timestamp Verification:`);
  console.log(`   - Found Date in deno.json:          ${releaseDateStr}`);
  console.log(`   - Latest Source File Modification:   ${maxMtimeStr}`);
  console.log("--------------------------------------------------");

  // Add 60-second buffer to ignore minor clock drift / execution offsets
  if (releaseDate.getTime() + 60000 < maxMtime.getTime()) {
    console.error(`❌ Error: releaseDate in deno.json (${releaseDateStr}) is out of date!`);
    console.error(`   A file was modified at ${maxMtimeStr} which is newer than deno.json.`);
    console.error("👉 Run 'deno task version-update', stage changes ('git add deno.json'), then try committing again.");
    Deno.exit(1);
  }

  console.log("✅ Version releaseDate is up-to-date with all source changes.");
  Deno.exit(0);
} catch (error) {
  console.error("❌ Error verifying releaseDate:", error.message);
  Deno.exit(1);
}
