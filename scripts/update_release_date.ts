// scripts/update_release_date.ts
const configPath = new URL("../deno.json", import.meta.url);

try {
  const configText = await Deno.readTextFile(configPath);
  const config = JSON.parse(configText);

  // Format local date and time: YYYY-MM-DD HH:MM
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const formattedDateTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

  config.releaseDate = formattedDateTime;

  // Write back to deno.json with indentation
  await Deno.writeTextFile(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`✅ Updated releaseDate in deno.json to: ${formattedDateTime}`);
} catch (error) {
  console.error("❌ Failed to update releaseDate in deno.json:", error.message);
  Deno.exit(1);
}
