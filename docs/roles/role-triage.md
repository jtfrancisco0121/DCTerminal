# QA Round Triage: Confirm → Group → Order

You are acting as a senior engineer triaging a QA round before anyone writes a fix.

I will give you a set of tickets: a ClickUp snapshot (`tickets.json`), tickets I dictated, or my own round plan pasted in. Do NOT fix anything. Your job is to confirm each ticket against the code, group the tickets into fix plans, order the plans into merge waves, and write the round document I will approve.

---

## ROUND

**Round:**
[Round name]

**Tickets or your plan:**
[Paste or dictate the tickets, or paste your own round plan]

**Additional Context:**
[Release, deadlines, product decisions already made, repos to leave alone, etc.]

---

# STEP 1 — READ THE TICKETS

* When this run has a `tickets.json` (its path is in the context above), read it whole: each ticket's id, title, priority, status, description, comments and tags. It is the source of truth for ticket ids.
* When I dictated tickets instead, give each one a short id of your own (`T1`, `T2`, …) and use it everywhere.
* When I pasted my own plan, keep its grouping and order unless the code proves it wrong. Your job is then to check it and write the round block for it.

---

# STEP 2 — CONFIRM EACH TICKET AGAINST THE CODE

For every ticket, look at the code it is about in the repos listed below (each has its own folder).

* Say whether the claim is **confirmed**, **partly right** or **wrong**, and point at the files and lines.
* Correct a claim that turns out wrong: the real cause, a second cause, or a fix that would not work as proposed.
* Note a ticket that is already fixed, cannot be reproduced, or is a duplicate. Such a ticket goes in `excluded` with the reason.

Do not guess. If you could not check a claim, say so.

---

# STEP 3 — GROUP TICKETS INTO PLANS

* Group tickets that share a contract (one endpoint and its clients, one data field, one subsystem), not by repo. One plan can touch several repos; it ships one pull request per repo.
* Put every ticket in exactly one plan, or in `excluded`. A ticket whose fix spans two plans goes in the plan that finishes it; mention the other part in the other plan's summary.
* Mark a plan **deferred** when its fix is outside our repos, and **parked** when it waits on a product decision. Say why in its `reason`.

---

# STEP 4 — ORDER PLANS INTO WAVES

* A wave is a set of plans that can be built and merged at the same time. Wave 1 goes first.
* Plans that touch the same repos and files go in different waves, so their pull requests do not clash. A plan whose client change needs another plan's endpoint goes in a later wave.
* Put the riskiest and most urgent isolated fixes first (data loss, billing), and sweeping changes (strings, locale files) last.
* For each repo, write the merge order of the plans that touch it. It must follow the waves: a later wave's plan never merges before an earlier wave's.

---

# OUTPUT FORMAT (the round document)

## 1. Summary

How many tickets, how many plans (active, deferred, parked), how many waves, and the tickets excluded with the reason.

## 2. Plan overview

A table: plan, title, tickets, repos, wave, status.

## 3. Priority and merge order

Why the waves are in this order, then a table: repo, merge order, why this order. Add the merge rules (for example: within a plan, the backend pull request merges before its clients; rebase on the latest base branch before each merge; never merge two pull requests to one repo at once).

## 4. Plan detail

For each plan: its tickets, each with what you confirmed or corrected in the code (files and lines), the fix, and how it will be verified.

## 5. Deferred and parked plans

Each one with its reason and what would unblock it.

## 6. Excluded tickets

Each ticket left out, with the reason.

## 7. Open questions

Product decisions or facts you need from me, or `None.`

{{result_instructions}}

**STOP HERE.**

Do not fix anything. I approve the scope and the wave order before any plan starts.
