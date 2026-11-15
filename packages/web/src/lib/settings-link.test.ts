import assert from "node:assert/strict";
import { test } from "node:test";
import { asksForAnswer, settingsHrefFor, settingsSectionFromHash } from "./settings-link.ts";

test("repo-mapping reasons point at the Repositories section", () => {
  assert.equal(settingsHrefFor("Map project PROJ to a repo in Settings"), "/settings#repos");
  assert.equal(settingsHrefFor("api: base branch main not found in /x — fix Settings"), "/settings#repos");
  assert.equal(settingsHrefFor("Repository api is no longer mapped for project P — fix Settings or choose a different solution"), "/settings#repos");
});

test("executor, JIRA and delivery reasons point at their sections", () => {
  assert.equal(settingsHrefFor("Set your Anthropic API key in Settings → Executor"), "/settings#executor");
  assert.equal(settingsHrefFor("The Anthropic API key was rejected — update it in Settings"), "/settings#executor");
  assert.equal(settingsHrefFor("The API executor cannot drive Chrome: use the JIRA API mode (Settings → JIRA)"), "/settings#jira");
  assert.equal(settingsHrefFor("Invalid JIRA browser in Settings"), "/settings#jira");
  assert.equal(settingsHrefFor("cannot run gh (gh): ENOENT — set delivery.ghBin in Settings"), "/settings#delivery");
});

test("any other reason naming Settings falls back to Settings itself", () => {
  assert.equal(settingsHrefFor("Something is wrong in Settings"), "/settings");
});

test("no link when the reason does not point at Settings", () => {
  assert.equal(settingsHrefFor("Login required — sign in to JIRA in Chrome, then Retry"), null);
  assert.equal(settingsHrefFor("the settings file was unreadable"), null);
  assert.equal(settingsHrefFor(null), null);
  assert.equal(settingsHrefFor(""), null);
});

test("settingsSectionFromHash accepts known section ids only", () => {
  assert.equal(settingsSectionFromHash("#repos"), "repos");
  assert.equal(settingsSectionFromHash("#preferences"), "preferences");
  assert.equal(settingsSectionFromHash("#nope"), null);
  assert.equal(settingsSectionFromHash(""), null);
});

test("asksForAnswer: the developer agent's question, or its idle stop, wants an answer on Retry", () => {
  assert.equal(asksForAnswer("Needs your input: What focus ring? — answer it on the ticket, then Retry"), true);
  assert.equal(asksForAnswer("The agent changed nothing in 2 steps and did not finish: gate unmet — answer what it needs on the ticket, then Retry"), true);
  assert.equal(asksForAnswer("Map project PROJ to a repo in Settings"), false);
  assert.equal(asksForAnswer(null), false);
});
