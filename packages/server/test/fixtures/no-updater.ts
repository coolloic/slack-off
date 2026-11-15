// Test helper: a JiraUpdater (and noCommenter, a JiraCommenter) for workflows whose tests never send a JIRA write (syncStatus stays off).
import type { JiraCommenter } from "../../src/jira/jira-commenter.ts";
import type { JiraUpdater } from "../../src/jira/jira-updater.ts";

export const noUpdater: JiraUpdater = {
  setStatus: async () => {
    throw new Error("no JIRA writes in this test");
  },
};

/** A JiraCommenter for workflows whose tests never post a JIRA comment. */
export const noCommenter: JiraCommenter = {
  postComment: async () => {
    throw new Error("no JIRA comments in this test");
  },
};
