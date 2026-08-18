// Duplicate-aware tab titles for the DynamoDB workspace strip — the labelling
// half of "Open in new tab", which puts one table on the strip twice.

import { describe, expect, it } from "vitest";

import { dynamoTabTitles, type DynamoWorkspaceTab } from "./workspaceTabs";

const tab = (title: string, table?: string): DynamoWorkspaceTab => ({
  id: title + (table ?? "") + Math.random(),
  kind: table ? "table" : "dashboard",
  title,
  table,
});

describe("dynamoTabTitles", () => {
  it("leaves unique titles untouched", () => {
    const tabs = [tab("Dashboard"), tab("ShopApp", "ShopApp"), tab("Sessions", "Sessions")];
    expect(dynamoTabTitles(tabs)).toEqual(["Dashboard", "ShopApp", "Sessions"]);
  });

  it("numbers repeats from the second one on", () => {
    const tabs = [tab("ShopApp", "ShopApp"), tab("ShopApp", "ShopApp"), tab("ShopApp", "ShopApp")];
    expect(dynamoTabTitles(tabs)).toEqual(["ShopApp", "ShopApp (2)", "ShopApp (3)"]);
  });

  it("counts each title independently and follows tab order", () => {
    const tabs = [
      tab("ShopApp", "ShopApp"),
      tab("Sessions", "Sessions"),
      tab("ShopApp", "ShopApp"),
      tab("Sessions", "Sessions"),
    ];
    expect(dynamoTabTitles(tabs)).toEqual(["ShopApp", "Sessions", "ShopApp (2)", "Sessions (2)"]);
  });

  it("handles an empty strip", () => {
    expect(dynamoTabTitles([])).toEqual([]);
  });
});
