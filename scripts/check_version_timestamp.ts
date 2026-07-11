// scripts/check_version_timestamp.ts
const configPath = new URL("../deno.json", import.meta.url);

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
  
  // Create local date object matching Deno host local timezone configuration
  const releaseDate = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hours),
    Number(minutes)
  );

  const now = new Date();
  const diffMs = Math.abs(now.getTime() - releaseDate.getTime());
  const diffMinutes = diffMs / (1000 * 60);

  // Enforce a maximum drift of 10 minutes
  if (diffMinutes > 10) {
    console.error(`❌ Error: releaseDate in deno.json (${releaseDateStr}) is out of date by ${Math.round(diffMinutes)} minutes!`);
    console.error("👉 Please run 'deno task version-update', stage the file ('git add deno.json'), and try committing again.");
    Deno.exit(1);
  }

  console.log("✅ Version releaseDate is up-to-date.");
  Deno.exit(0);
} catch (error) {
  console.error("❌ Error verifying releaseDate:", error.message);
  Deno.exit(1);
}
