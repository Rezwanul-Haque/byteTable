// Dev gallery — renders every shared UI primitive plus the PreferencesPanel
// so M0 visuals can be eyeballed against the prototype. Dev-only surface;
// replaced by the real app shell in later milestones.

import { useState } from "react";

import { BTLogo } from "../shared/ui/BTLogo";
import { Btn } from "../shared/ui/Btn";
import { EngineBadge, type Engine } from "../shared/ui/EngineBadge";
import { EnvTag, type Env } from "../shared/ui/EnvTag";
import { Icon } from "../shared/ui/Icon";
import { IconBtn } from "../shared/ui/IconBtn";
import { Kbd } from "../shared/ui/Kbd";
import { Modal, ModalActions, ModalTitle } from "../shared/ui/Modal";
import { useToast } from "../shared/ui/toastContext";
import { PreferencesPanel } from "../features/preferences/components/PreferencesPanel";
import "./Gallery.css";

const ENGINES: Engine[] = ["sqlite", "mysql", "postgres"];
const ENVS: Env[] = ["local", "staging", "production"];

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="gallery-section">
      <div className="gallery-section-label">{label}</div>
      {children}
    </section>
  );
}

export function Gallery() {
  const toast = useToast();
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <main className="gallery">
      <header className="gallery-header">
        <BTLogo size={28} blink />
        <div>
          <h1>ByteTable UI gallery</h1>
          <p>M0 shared primitives — dev-only page</p>
        </div>
      </header>

      <Section label="Logo">
        <div className="gallery-row">
          <BTLogo size={24} blink />
          <BTLogo size={36} blink />
          <span className="gallery-brand-mark">
            <BTLogo size={26} blink />
          </span>
          <span className="gallery-note">cursor blinks 1.2s steps(2); static without `blink`:</span>
          <BTLogo size={24} />
        </div>
      </Section>

      <Section label="Buttons">
        <div className="gallery-row">
          <Btn variant="filled" icon="play_arrow">
            Run query
          </Btn>
          <Btn variant="tonal" icon="add">
            New connection
          </Btn>
          <Btn variant="text" icon="refresh">
            Refresh
          </Btn>
          <Btn variant="filled" disabled>
            Disabled
          </Btn>
        </div>
        <div className="gallery-row">
          <Btn variant="filled" small>
            Small filled
          </Btn>
          <Btn variant="tonal" small icon="folder_open">
            Browse…
          </Btn>
          <Btn variant="text" small>
            Small text
          </Btn>
          <span className="gallery-note">
            hover: filled brightens 10%, tonal deepens to 22% accent, text gains --bg2
          </span>
        </div>
      </Section>

      <Section label="Icon buttons">
        <div className="gallery-row">
          <IconBtn icon="close" title="Default" />
          <IconBtn icon="filter_list" title="Active" active />
          <IconBtn icon="delete" title="Danger (hover)" danger />
          <span className="gallery-note">26×26 min hit target; danger tints red on hover</span>
        </div>
      </Section>

      <Section label="Engine badges">
        <div className="gallery-row">
          {ENGINES.map((engine) => (
            <EngineBadge key={engine} engine={engine} size={22} />
          ))}
          {ENGINES.map((engine) => (
            <EngineBadge key={engine + "-28"} engine={engine} size={28} />
          ))}
        </div>
      </Section>

      <Section label="Environment tags">
        <div className="gallery-row">
          {ENVS.map((env) => (
            <EnvTag key={env} env={env} />
          ))}
        </div>
      </Section>

      <Section label="Kbd">
        <div className="gallery-row">
          <span className="gallery-note">
            Press <Kbd>⌘K</Kbd> to jump, <Kbd>⌘T</Kbd> for a SQL query, <Kbd>esc</Kbd> to close.
          </span>
        </div>
      </Section>

      <Section label="Icons">
        <div className="gallery-row">
          <Icon name="database" />
          <Icon name="table" />
          <Icon name="search" />
          <Icon name="favorite" fill={1} style={{ color: "var(--donate-pink)" }} />
          <Icon name="check_circle" size={24} style={{ color: "var(--accent)" }} />
          <span className="gallery-note">Material Symbols Rounded — FILL via prop</span>
        </div>
      </Section>

      <Section label="Toasts">
        <div className="gallery-row">
          <Btn small onClick={() => toast("UPDATE orders — 1 row affected", "ok")}>
            ok toast
          </Btn>
          <Btn small onClick={() => toast("connection refused (os error 61)", "err")}>
            err toast
          </Btn>
          <Btn small onClick={() => toast("Schema reloaded", "info")}>
            info toast
          </Btn>
          <span className="gallery-note">bottom-right stack, auto-dismiss 3.2s</span>
        </div>
      </Section>

      <Section label="Modal">
        <div className="gallery-row">
          <Btn variant="tonal" icon="open_in_new" onClick={() => setModalOpen(true)}>
            Open modal
          </Btn>
          <span className="gallery-note">closes via Esc or scrim click</span>
        </div>
      </Section>

      <Section label="Preferences">
        <PreferencesPanel />
      </Section>

      {modalOpen ? (
        <Modal label="Example modal" onClose={() => setModalOpen(false)}>
          <ModalTitle>
            <span>Example modal</span>
            <IconBtn icon="close" onClick={() => setModalOpen(false)} title="Close" />
          </ModalTitle>
          <p className="gallery-modal-body">
            Scrim + centered panel per the prototype. Press <Kbd>esc</Kbd> or click the scrim to
            close.
          </p>
          <ModalActions>
            <Btn variant="text" onClick={() => setModalOpen(false)}>
              Cancel
            </Btn>
            <Btn
              variant="filled"
              onClick={() => {
                setModalOpen(false);
                toast("Confirmed", "ok");
              }}
            >
              Confirm
            </Btn>
          </ModalActions>
        </Modal>
      ) : null}
    </main>
  );
}
