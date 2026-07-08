// Example plugin: a minimal single-command plugin. Good starting point if you just want
// to add one small command - see plugins/checkage for a more involved example (event
// hooks, moderation actions, persisted config).
import type { BotAPI, CommandContext, CommandDefinition, Plugin } from "../../src/plugins/types";

const MAX_DICE = 100;
const MAX_SIDES = 1000;
// Above this many dice, listing every individual roll would just be noise - show the total only.
const MAX_ROLLS_SHOWN = 20;

function rollDice(count: number, sides: number): number[] {
  const rolls: number[] = [];
  for (let i = 0; i < count; i++) {
    rolls.push(1 + Math.floor(Math.random() * sides));
  }
  return rolls;
}

function createDiceCommand(): CommandDefinition {
  return {
    name: "dice",
    level: "everyone",
    description: "Rolls X dice with Y sides.",
    usage: "!dice <X>d<Y>",
    async handler(ctx: CommandContext) {
      const match = /^(\d+)d(\d+)$/i.exec(ctx.rawArgs.trim());
      const countStr = match?.[1];
      const sidesStr = match?.[2];
      if (countStr === undefined || sidesStr === undefined) {
        await ctx.reply("Usage: !dice <X>d<Y>, e.g. !dice 2d6");
        return;
      }

      const count = Number(countStr);
      const sides = Number(sidesStr);

      if (count < 1 || count > MAX_DICE) {
        await ctx.reply(`Number of dice must be between 1 and ${MAX_DICE}.`);
        return;
      }
      if (sides < 2 || sides > MAX_SIDES) {
        await ctx.reply(`Number of sides must be between 2 and ${MAX_SIDES}.`);
        return;
      }

      const rolls = rollDice(count, sides);
      const total = rolls.reduce((sum, r) => sum + r, 0);
      const rollList = rolls.length <= MAX_ROLLS_SHOWN ? ` [${rolls.join(", ")}]` : "";
      await ctx.reply(`${ctx.senderCharacter} rolls ${count}d${sides}:${rollList} = ${total}`);
    },
  };
}

const dicePlugin = (_api: BotAPI): Plugin => ({
  id: "dice",
  name: "Dice Roller",
  version: "1.0.0",
  commands: [createDiceCommand()],
});

export default dicePlugin;
