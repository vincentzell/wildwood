import { expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { installSettingsTabs } from "./settings-tabs";

it("groups existing controls without nesting, preserving state and handlers and leaving Tutorial last", () => {
  const { document } = parseHTML(`<html><body><section id="settingsPanel">
    <h2 id="settingsTitle">Settings</h2>
    <div class="setting-row"><span>Attack Range</span><button id="attackRangeToggle" aria-pressed="false">OFF</button></div>
    <div class="setting-row"><span>Chat</span><button id="chatToggle">ON</button></div>
    <div class="setting-row"><span>FPS</span><button id="fpsToggle">ON</button></div>
    <div class="setting-row"><button id="statTrackerToggle">ON</button></div>
    <div class="window-back-footer"><button>Back</button></div>
    </section></body></html>`);
  const toggle = document.getElementById("attackRangeToggle")!;
  const click = vi.fn();
  toggle.addEventListener("click", click);
  installSettingsTabs(document as unknown as Document);
  const panel = document.getElementById("settings-game-panel")!;
  const groups = [...panel.querySelectorAll("details")];
  expect(groups).toHaveLength(3);
  expect(groups.map(group => group.querySelector("summary > span")!.textContent))
    .toEqual(["Display & HUD", "Players & Social", "Device & Performance"]);
  expect(panel.querySelector("details details")).toBeNull();
  expect(groups.every(group => !group.hasAttribute("open"))).toBe(true);
  expect(groups[0].querySelector("#attackRangeToggle")).toBe(toggle);
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  toggle.click();
  expect(click).toHaveBeenCalledOnce();
  expect(groups[1].querySelector("#chatToggle")).not.toBeNull();
  expect(groups[2].querySelector("#fpsToggle")).not.toBeNull();
  expect(panel.lastElementChild!.querySelector("#replayTutorialBtn")).not.toBeNull();
});
