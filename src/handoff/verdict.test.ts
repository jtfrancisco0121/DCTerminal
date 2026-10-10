import { describe, expect, it } from "vitest";
import {
  isReviewerRole,
  needsRevision,
  parseReviewVerdict,
  parseTerminalVerdict,
  verdictTone,
} from "./verdict";

describe("parseTerminalVerdict", () => {
  it("reads the newest round in a terminal's scrollback", () => {
    const tail = "Verdict: REQUIRES REVISION\nfixed it\n## Verdict\nAPPROVED\nanything else";
    expect(parseTerminalVerdict(tail)).toBe("APPROVED");
    // The chat reader also takes the newest Verdict label now.
    expect(parseReviewVerdict(tail)).toBe("APPROVED");
    expect(parseTerminalVerdict("rounds later: rejected")).toBe("REJECTED");
    expect(parseTerminalVerdict("no decision yet")).toBeNull();
  });
});

describe("parseReviewVerdict", () => {
  it("reads each verdict, case-insensitive", () => {
    expect(parseReviewVerdict("Overall: approved.")).toBe("APPROVED");
    expect(parseReviewVerdict("APPROVED WITH CHANGES")).toBe("APPROVED WITH CHANGES");
    expect(parseReviewVerdict("This plan Requires Revision.")).toBe("REQUIRES REVISION");
    expect(parseReviewVerdict("Decision: request changes")).toBe("REQUEST CHANGES");
    expect(parseReviewVerdict("I have requested changes")).toBe("REQUEST CHANGES");
    expect(parseReviewVerdict("Verdict: changes requested")).toBe("REQUEST CHANGES");
    expect(parseReviewVerdict("## Verdict\nREJECTED")).toBe("REJECTED");
  });

  it("never reads approved with changes as approved", () => {
    expect(parseReviewVerdict("**Approved   with\nchanges**")).toBe("APPROVED WITH CHANGES");
  });

  it("prefers the line under a Verdict heading", () => {
    const reply = [
      "The earlier draft was approved by nobody.",
      "",
      "### Verdict",
      "",
      "**REQUIRES REVISION**",
      "",
      "## Reviewed plan",
      "Once fixed this can be approved.",
    ].join("\n");
    expect(parseReviewVerdict(reply)).toBe("REQUIRES REVISION");
  });

  it("reads a verdict on the label line", () => {
    expect(parseReviewVerdict("Verdict: Approved with changes\n\nLater: approved")).toBe(
      "APPROVED WITH CHANGES",
    );
  });

  it("falls back to the last verdict phrase", () => {
    expect(parseReviewVerdict("Not approved yet... request changes")).toBe("REQUEST CHANGES");
  });

  it("returns null without a verdict", () => {
    expect(parseReviewVerdict("")).toBeNull();
    expect(parseReviewVerdict("Looks fine, reviewing more later.")).toBeNull();
    expect(parseReviewVerdict("unapproved")).toBeNull();
  });

  it("reads verdicts written in prose", () => {
    expect(parseReviewVerdict("I approve this plan with changes.")).toBe("APPROVED WITH CHANGES");
    expect(parseReviewVerdict("Approved, with minor changes listed below.")).toBe(
      "APPROVED WITH CHANGES",
    );
    expect(parseReviewVerdict("I approve this plan.")).toBe("APPROVED");
    expect(parseReviewVerdict("The plan needs revision before anyone builds it.")).toBe(
      "REQUIRES REVISION",
    );
    expect(parseReviewVerdict("I'm requesting changes on two points.")).toBe("REQUEST CHANGES");
  });

  it("does not read the approved plan or a negation as a verdict", () => {
    expect(parseReviewVerdict("The code follows the approved plan closely.")).toBeNull();
    expect(parseReviewVerdict("Matches the Approved Implementation Plan.")).toBeNull();
    expect(parseReviewVerdict("This is not approved.")).toBeNull();
    expect(parseReviewVerdict("Not approved yet: requires revision.")).toBe("REQUIRES REVISION");
  });

  it("reads bold, numbered and labelled Verdict headings", () => {
    expect(parseReviewVerdict("**Verdict:** **APPROVED WITH CHANGES**")).toBe("APPROVED WITH CHANGES");
    expect(parseReviewVerdict("## 1. Verdict\n\nAfter checking the code:\n\n**REQUIRES REVISION**")).toBe(
      "REQUIRES REVISION",
    );
    // A verdict word in the reviewed plan after the heading does not win.
    expect(
      parseReviewVerdict("### Verdict\n**REQUIRES REVISION**\n\n## Reviewed plan\n1. Show approved requests"),
    ).toBe("REQUIRES REVISION");
    // A sentence that merely mentions a verdict is not a label.
    expect(parseReviewVerdict("We store the verdict per round.\nApproved.")).toBe("APPROVED");
  });

  it("falls back to the Final Recommendation option", () => {
    const reply = (option: string) =>
      `### 9. Final Recommendation\n\n- **${option}**\n\n## Reviewed plan\n1. Step`;
    expect(parseReviewVerdict(reply("Proceed as-is"))).toBe("APPROVED");
    expect(parseReviewVerdict(reply("Update the plan, then proceed"))).toBe("APPROVED WITH CHANGES");
    expect(parseReviewVerdict(reply("Return to planning because significant changes are required"))).toBe(
      "REQUIRES REVISION",
    );
    // A written verdict beats the recommendation.
    expect(parseReviewVerdict(`## Verdict\nAPPROVED\n\n${reply("Return to planning")}`)).toBe("APPROVED");
  });

  it("tones and reviewer roles", () => {
    expect(verdictTone("APPROVED")).toBe("ok");
    expect(verdictTone("APPROVED WITH CHANGES")).toBe("warn");
    expect(verdictTone("REQUEST CHANGES")).toBe("bad");
    expect(isReviewerRole("role_pr_reviewer")).toBe(true);
    expect(isReviewerRole("role_implementer")).toBe(false);
    expect(verdictTone("REJECTED")).toBe("bad");
    expect(needsRevision("REJECTED")).toBe(true);
    expect(needsRevision("APPROVED WITH CHANGES")).toBe(false);
    expect(needsRevision(null)).toBe(false);
  });
});

describe("verdict words inside a plan", () => {
  it("a revised plan with no verdict line is not read as a rejection", () => {
    const revisedPlan = [
      "Acceptance criteria.",
      "- [ ] Blank rows skipped; partial, negative and qty-0 rows rejected; 1 to 17 rows.",
      "- [ ] A manual EWT larger than G with Less is rejected.",
      "| Case | Result |",
      "| --- | --- |",
      "| zero price | rejected |",
      "```",
      "assert status == 'rejected'",
      "```",
      "Open questions. Defaults below are used if no answer is given.",
    ].join("\n");
    expect(parseReviewVerdict(revisedPlan)).toBeNull();
    expect(parseTerminalVerdict(revisedPlan)).toBeNull();
  });

  it("a verdict stated in prose still counts", () => {
    expect(parseReviewVerdict("- step one\n\nOverall the plan is rejected.")).toBe("REJECTED");
  });
});
