import { describe, expect, it } from "vitest";
import { isReviewerRole, needsRevision, parseReviewVerdict, verdictTone } from "./verdict";

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
