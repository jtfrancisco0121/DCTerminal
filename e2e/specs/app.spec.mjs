import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const folder = fs.readFileSync(path.join(root, "e2e", ".tmp", "folder.txt"), "utf8").trim();

async function clickButton(name) {
  const button = await $(`button=${name}`);
  await button.waitForDisplayed({ timeout: 20000 });
  await button.click();
}

describe("DCTerminal", () => {
  it("shows a role and a folder chooser", async () => {
    const chooser = await $("button=Choose folder…");
    await chooser.waitForDisplayed({ timeout: 30000 });
    const developer = await $("button=Developer");
    await expect(developer).toBeDisplayed();
  });

  it("shows Developer fields and a plain history line for the folder", async () => {
    await clickButton("Developer");
    await clickButton("Recent");
    const input = await $('[aria-label="Enter a folder path"]');
    await input.waitForDisplayed();
    await input.setValue(folder);
    await clickButton("Use path");
    const title = await $("aria/Title");
    await title.waitForDisplayed({ timeout: 15000 });
    const task = await $("aria/What to work on");
    await expect(task).toBeDisplayed();
    const hint = await $("p=Saved sessions for this folder.");
    await hint.waitForDisplayed({ timeout: 15000 });
    await expect($("button=Resume")).toBeDisplayed();
    await expect($("button=Open in Cursor CLI")).toBeDisplayed();
    const source = await browser.getPageSource();
    expect(source).not.toContain("session/load");
    expect(source).not.toContain("Senior Software Engineer");
  });

  it("opens Settings and closes it again", async () => {
    const gear = await $('[aria-label="Settings"]');
    await gear.click();
    const heading = await $("h2=Settings");
    await heading.waitForDisplayed();
    await expect($("label=Shell program")).toBeDisplayed();
    await clickButton("Close");
    const chooser = await $("button=Choose folder…");
    await chooser.waitForDisplayed();
  });

  it("starts a chat against the fake agent", async () => {
    if (process.env.DCT_E2E_LIVE === "1") return;
    await clickButton("Start");
    await browser.waitUntil(
      async () => (await browser.getPageSource()).includes("DCTerminal fake agent ready"),
      { timeout: 40000, timeoutMsg: "the fake agent reply did not appear" },
    );
  });
});
