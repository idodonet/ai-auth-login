import type { PersistedTab, ProviderDescriptor } from "../shared/types";
export function SessionTabs({
  tabs,
  activeId,
  providers,
  select,
  close,
  add,
}: {
  tabs: PersistedTab[];
  activeId: string;
  providers: readonly ProviderDescriptor[];
  select: (id: string) => void;
  close: (id: string) => void;
  add: () => void;
}) {
  return (
    <nav className="tabs" aria-label="Provider connections">
      {tabs.map((tab, index) => (
        <div className={tab.id === activeId ? "tab active" : "tab"} key={tab.id}>
          <button
            aria-current={tab.id === activeId ? "page" : undefined}
            onClick={() => select(tab.id)}
          >
            {providers.find((provider) => provider.id === tab.provider)?.name ??
              `Connection ${index + 1}`}
            {tab.provider &&
              tabs.filter((item) => item.provider === tab.provider).length > 1 &&
              ` · ${tabs.slice(0, index + 1).filter((item) => item.provider === tab.provider).length}`}
          </button>
          <button aria-label={`Close connection ${index + 1}`} onClick={() => close(tab.id)}>
            ×
          </button>
        </div>
      ))}
      <button className="add" aria-label="Add connection" onClick={add}>
        +
      </button>
    </nav>
  );
}
