import { useEffect, useRef, useState } from "react";
import { Bell, Search, Settings, X } from "lucide-react";
import type { Brand } from "../types";
import { brandColor, initials } from "../format";

interface Props {
  me: { name: string; email: string } | null;
  brand: Brand | null;
  onSearch: (q: string) => void;
  searchActive: boolean;
}

export function TopBar({ me, brand, onSearch, searchActive }: Props) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchOpen) inputRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (!searchActive) setQ("");
  }, [searchActive]);

  const close = () => {
    setSearchOpen(false);
    setQ("");
    if (searchActive) onSearch("");
  };

  return (
    <header className="topbar">
      <span className="wordmark">WorkDrive</span>
      <span className="spacer" />
      {searchOpen ? (
        <div className="topbar-search">
          <Search size={15} />
          <input
            ref={inputRef}
            value={q}
            placeholder={`Search in ${brand?.name ?? "team"}…`}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSearch(q);
              if (e.key === "Escape") close();
            }}
          />
          <button className="icon-btn" onClick={close} title="Close search">
            <X size={15} />
          </button>
        </div>
      ) : (
        <button
          className="icon-btn"
          title="Search"
          onClick={() => setSearchOpen(true)}
        >
          <Search size={17} />
        </button>
      )}
      <button className="icon-btn" title="Notifications">
        <Bell size={17} />
      </button>
      <button className="icon-btn" title="Settings">
        <Settings size={17} />
      </button>
      <div
        className="avatar"
        title={me ? `${me.name} (${me.email})` : ""}
        style={brand ? { background: brandColor(brand.code) } : undefined}
      >
        {me ? initials(me.name || me.email) : "…"}
      </div>
    </header>
  );
}
