import { useState, useRef, useEffect, useId } from "react";
import "./FilterSelect.css";

// -----------------------------------------------------------------------------
// FilterSelect — simple custom dropdown.
// BEHAVIOUR (kept deliberately boring):
//   - The list ALWAYS opens downward, anchored under the trigger.
//   - The list is absolutely positioned, so it floats above whatever is
//     below it instead of pushing content around.
//   - Click an option to choose it; click anywhere outside (or press
//     Escape) to close without choosing. Clicking the trigger toggles.
//   - Opening one dropdown closes any other open one.
// Accessibility: aria-haspopup/listbox/option roles, aria-expanded/selected,
//   Escape closes and refocuses the trigger, ArrowDown/Enter opens the list.
// -----------------------------------------------------------------------------
function FilterSelect({ label, value, options, onChange, compact = false, align = "left" }) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef(null);
    const listRef = useRef(null);
    const instanceId = useId();

    const selected =
        options.find((option) => String(option.value) === String(value)) || null;

    useEffect(() => {
        if (!open) return;
        const onPointerDown = (e) => {
            // Click inside this dropdown (trigger or list) — let it behave
            // normally. Anything outside closes the list.
            if (!rootRef.current?.contains(e.target)) setOpen(false);
        };
        const onKeyDown = (e) => {
            if (e.key === "Escape") {
                setOpen(false);
                rootRef.current?.querySelector("button")?.focus();
            }
        };
        // Another dropdown opened elsewhere — yield so only one stays open.
        const onOtherOpen = (e) => {
            if (e.detail !== instanceId) setOpen(false);
        };
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        window.addEventListener("fs:open", onOtherOpen);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("fs:open", onOtherOpen);
        };
    }, [open, instanceId]);

    const openList = () => {
        setOpen(true);
        window.dispatchEvent(new CustomEvent("fs:open", { detail: instanceId }));
    };

    const focusFirstOption = () => {
        listRef.current?.querySelector("button")?.focus();
    };

    return (
        <div ref={rootRef} className={`fs${compact ? " fs--compact" : ""}`}>
            <button
                type="button"
                className="fs__btn"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={compact ? label : undefined}
                onClick={() => (open ? setOpen(false) : openList())}
                onKeyDown={(e) => {
                    if ((e.key === "ArrowDown" || e.key === "Enter") && !open) {
                        e.preventDefault();
                        openList();
                        setTimeout(focusFirstOption, 0);
                    }
                }}
            >
                {!compact && <span className="fs__label">{label}</span>}
                <span className="fs__value" title={selected ? selected.label : ""}>
                    {selected ? selected.label : "Select…"}
                    <svg
                        className={`fs__chev${open ? " is-open" : ""}`}
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        aria-hidden="true"
                    >
                        <path
                            d="M6 9l6 6 6-6"
                            stroke="currentColor"
                            strokeWidth="2.4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    </svg>
                </span>
            </button>
            {open && (
                <ul
                    ref={listRef}
                    className={`fs__list${align === "right" ? " fs__list--right" : ""}`}
                    role="listbox"
                    aria-label={label}
                >
                    {options.map((option) => {
                        const isSelected = String(option.value) === String(value);
                        return (
                            <li key={String(option.value)} role="presentation">
                                <button
                                    type="button"
                                    role="option"
                                    aria-selected={isSelected}
                                    className={isSelected ? "is-selected" : ""}
                                    title={option.label}
                                    onClick={() => {
                                        onChange(option.value);
                                        setOpen(false);
                                    }}
                                >
                                    {option.label}
                                    {isSelected && (
                                        <span className="fs__tick" aria-hidden="true">
                                            ✓
                                        </span>
                                    )}
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

export default FilterSelect;
