"use client";

import { useState, useEffect, useId, useRef } from "react";

import { cn } from "@/lib/cn";
import { locationLookupAction } from "@/lib/locationLookup";
import { fieldBaseClasses } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

interface LocationSuggestion {
  description: string;
  latitude: number;
  longitude: number;
  placeId: string;
}

interface LocationAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** Input id so a `<Label htmlFor>` can associate. Defaults to a generated id. */
  id?: string;
}

export function LocationAutocomplete({
  value,
  onChange,
  placeholder = "e.g., Miami Beach, FL",
  className = "",
  id,
}: LocationAutocompleteProps) {
  const [suggestions, setSuggestions] = useState<LocationSuggestion[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const debounceTimer = useRef<NodeJS.Timeout | null>(null);
  // The value a suggestion selection wrote into the field. The lookup effect
  // skips exactly that value, otherwise picking a suggestion triggered a fresh
  // lookup that re-opened the dropdown ~300ms later (2026-11-01 audit).
  const selectedValueRef = useRef<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const generatedId = useId();
  const inputId = id ?? generatedId;
  const listboxId = `${inputId}-listbox`;
  const optionId = (index: number) => `${inputId}-option-${index}`;

  const isOpen = showDropdown && suggestions.length > 0;

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Fetch suggestions when user types
  useEffect(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    const action = locationLookupAction(value, selectedValueRef.current);
    // Anything but the selection's own value means the user is typing again.
    if (action !== "skip") selectedValueRef.current = null;

    if (action === "clear" || action === "skip") {
      // The pending debounce above was just cancelled, so its `finally` will
      // never clear the spinner - do it here.
      setIsLoading(false);
      if (action === "clear") {
        setSuggestions([]);
        setSelectedIndex(-1);
        setShowDropdown(false);
      }
      return;
    }

    setIsLoading(true);

    // Set when this lookup is superseded (the value changed - including by a
    // selection - or the component unmounted), so a response that arrives late
    // can't re-open the dropdown over the user's choice.
    let superseded = false;

    debounceTimer.current = setTimeout(async () => {
      try {
        const response = await fetch(`/api/geocode?query=${encodeURIComponent(value)}`);
        if (response.ok) {
          const data = await response.json();
          if (superseded) return;
          setSuggestions(data.suggestions || []);
          setSelectedIndex(-1);
          setShowDropdown(true);
        }
      } catch (error) {
        console.error("Failed to fetch location suggestions", error);
      } finally {
        if (!superseded) setIsLoading(false);
      }
    }, 300);

    return () => {
      superseded = true;
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, [value]);

  const handleSelect = (suggestion: LocationSuggestion) => {
    // Format as "Description (lat,lng)"
    const formatted = `${suggestion.description} (${suggestion.latitude},${suggestion.longitude})`;
    selectedValueRef.current = formatted;
    onChange(formatted);
    // The list belonged to what was typed; a later focus must not resurrect it.
    setSuggestions([]);
    setShowDropdown(false);
    setSelectedIndex(-1);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showDropdown || suggestions.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev < suggestions.length - 1 ? prev + 1 : prev));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : -1));
    } else if (e.key === "Enter" && selectedIndex >= 0) {
      e.preventDefault();
      handleSelect(suggestions[selectedIndex]);
    } else if (e.key === "Escape") {
      setShowDropdown(false);
      setSelectedIndex(-1);
    }
  };

  return (
    <div ref={wrapperRef} className="relative">
      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={
          isOpen && selectedIndex >= 0 ? optionId(selectedIndex) : undefined
        }
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          if (suggestions.length > 0) setShowDropdown(true);
        }}
        className={cn(fieldBaseClasses, "h-10 px-3 py-2", className)}
        placeholder={placeholder}
        autoComplete="off"
      />

      {isOpen && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Location suggestions"
          className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-[var(--radius)] border border-input bg-card text-card-foreground shadow-lg"
        >
          {suggestions.map((suggestion, index) => (
            <li key={suggestion.placeId} role="presentation">
              <button
                id={optionId(index)}
                type="button"
                role="option"
                aria-selected={index === selectedIndex}
                onClick={() => handleSelect(suggestion)}
                onMouseEnter={() => setSelectedIndex(index)}
                className={cn(
                  "w-full border-b border-border px-3 py-2 text-left text-sm transition-colors last:border-b-0 hover:bg-accent hover:text-accent-foreground",
                  index === selectedIndex && "bg-accent text-accent-foreground"
                )}
              >
                <div className="font-medium text-foreground">{suggestion.description}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {suggestion.latitude.toFixed(4)}, {suggestion.longitude.toFixed(4)}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {isLoading && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2">
          <Spinner size="sm" className="text-muted-foreground" />
        </div>
      )}
    </div>
  );
}
