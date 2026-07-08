import { loadConfig } from "./config/env";
import { Bot } from "./core/Bot";

async function main(): Promise<void> {
  const config = loadConfig();
  const bot = new Bot(config);

  process.on("SIGINT", () => void bot.shutdown("clean"));
  process.on("SIGTERM", () => void bot.shutdown("clean"));
  process.on("uncaughtException", (err) => {
    // eslint-disable-next-line no-console
    console.error("Uncaught exception:", err);
    process.exitCode = process.exitCode ?? 1;
    void bot.shutdown("clean");
  });

  await bot.start();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal startup error:", err);
  process.exit(1);
});
