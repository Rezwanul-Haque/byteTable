// The collapsed inspector: a 44px icon rail on the board's right edge, the
// mirror of the tool rail on its left.
//
// The full panel costs the canvas 272px for content that is mostly glanced at
// (compare source, live tables, groups, shortcuts), so unpinned the board keeps
// only this rail. Each icon opens its one section as a floating drawer, which
// overlays the canvas instead of narrowing it — no re-fit, no jump. Selecting
// something still brings up the full object inspector (as a floating panel);
// that is where editing happens, and it should never cost an extra click.

import { Icon } from "../../../shared/ui/Icon";
import { useT } from "../../../shared/i18n/useT";

export type RailDrawer = "compare" | "tables" | "groups" | "keys" | "board";

export interface BoardSideRailProps {
  drawer: RailDrawer | null;
  setDrawer: (drawer: RailDrawer | null) => void;
  onPin: () => void;
  /** Hides the live-tables icon — with nothing to compare there are none. */
  comparing: boolean;
  liveCount: number | null;
  groupCount: number;
  /** Pending creates + alters against the live schema. */
  diffCount: number;
  /** Marks the shortcuts icon until the user has opened it once. */
  keysUnseen: boolean;
}

export function BoardSideRail(props: BoardSideRailProps) {
  const t = useT();
  const { drawer, setDrawer, onPin, comparing, liveCount, groupCount, diffCount, keysUnseen } =
    props;

  const item = (id: RailDrawer, icon: string, title: string, badge?: string | null) => (
    <button
      type="button"
      className={"bb-tool" + (drawer === id ? " on" : "")}
      title={title}
      aria-label={title}
      aria-pressed={drawer === id}
      onClick={() => setDrawer(drawer === id ? null : id)}
    >
      <Icon name={icon} size={17} />
      {badge ? <span className="bb-srail-n">{badge}</span> : null}
    </button>
  );

  return (
    <div className="bb-srail">
      {item(
        "compare",
        "difference",
        t("board.sec.compare"),
        comparing && diffCount > 0 ? String(diffCount) : null,
      )}
      {comparing
        ? item(
            "tables",
            "table_rows",
            t("board.sec.liveTables"),
            liveCount !== null && liveCount > 0 ? String(liveCount) : null,
          )
        : null}
      {item(
        "groups",
        "workspaces",
        t("board.sec.groups"),
        groupCount > 0 ? String(groupCount) : null,
      )}
      {item("keys", "keyboard", t("board.sec.shortcuts") + " (?)", keysUnseen ? "•" : null)}
      <div className="bb-srail-fill" />
      {item("board", "more_horiz", t("board.rail.board"))}
      <button
        type="button"
        className="bb-tool"
        title={t("board.rail.pin")}
        aria-label={t("board.rail.pin")}
        onClick={onPin}
      >
        <Icon name="push_pin" size={17} />
      </button>
    </div>
  );
}
