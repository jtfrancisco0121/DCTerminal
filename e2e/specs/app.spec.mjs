import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tmp = path.join(root, "e2e", ".tmp");
const folder = fs.readFileSync(path.join(tmp, "folder.txt"), "utf8").trim();

function samePath(left, right) {
  const normalize = (value) => path.resolve(String(value)).replace(/[\\/]+$/u, "");
  if (process.platform === "win32") {
    return normalize(left).toLowerCase() === normalize(right).toLowerCase();
  }
  return normalize(left) === normalize(right);
}

async function clickButton(name) {
  const button = await $(`button=${name}`);
  await button.waitForDisplayed({ timeout: 20000 });
  await button.click();
}

async function openBlankTab() {
  const created = await $("button=+ New tab");
  await created.waitForDisplayed({ timeout: 30000 });
  await created.click();
  const developer = await $("button=Developer");
  await developer.waitForDisplayed({
    timeout: 30000,
    timeoutMsg: "role picker did not appear on a new tab",
  });
}

async function appDataDir() {
  return browser.execute(() => {
    const node = [...document.querySelectorAll("dt")].find((el) => el.textContent === "App data");
    return node?.nextElementSibling?.textContent ?? "";
  });
}

describe("DCTerminal", () => {
  it("uses the isolated data directory before anything else", async () => {
    const expected = fs.readFileSync(path.join(tmp, "data-dir.txt"), "utf8").trim();
    const resolved = path.resolve(expected);
    const insideTmp = resolved.startsWith(`${path.resolve(tmp)}${path.sep}`);
    if (!insideTmp) {
      throw new Error(`Refusing to start: expected data dir is outside e2e/.tmp (${expected})`);
    }
    const gear = await $('[aria-label="Settings"]');
    await gear.waitForDisplayed({ timeout: 30000 });
    await gear.click();
    let actual = "";
    try {
      await browser.waitUntil(
        async () => {
          actual = await appDataDir();
          return samePath(actual, expected);
        },
        { timeout: 20000 },
      );
    } catch {
      const actualText = JSON.stringify(actual);
      throw new Error(
        `Refusing to continue: DCTerminal data dir is ${actualText}, expected ${expected}`,
      );
    }
    await clickButton("Close");
  });

  it("shows a role and a folder chooser", async () => {
    await openBlankTab();
    const chooser = await $("button=Choose folder…");
    await chooser.waitForDisplayed({ timeout: 30000 });
    const developer = await $("button=Developer");
    await expect(developer).toBeDisplayed();
  });

  it("shows Developer fields and a plain history line for the folder", async () => {
    await openBlankTab();
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
    const startNew = await $("button=Start new session");
    if (await startNew.isExisting()) {
      try {
        if (await startNew.isDisplayed()) await startNew.click();
      } catch {
        // The blank tab is already on the startup form.
      }
    }
    await clickButton("Start");
    await browser.waitUntil(
      async () => (await browser.getPageSource()).includes("DCTerminal fake agent ready"),
      { timeout: 40000, timeoutMsg: "the fake agent reply did not appear" },
    );
  });
});
