import { Palette, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useBackgroundColor,
  useForegroundColor,
  useSidebarColor,
  useSidebarForegroundColor,
} from "../hooks/use-theme-color";
import { cn } from "@/lib/utils";

// Curated swatches for the page background — the original theme pink
// plus a few neutral/soft options — rather than a raw color wheel, so
// everything still looks intentional against the card/text colors.
const BACKGROUND_OPTIONS: { name: string; value: string }[] = [
  { name: "Rani Blush", value: "#FFF5F8" },
  { name: "Pure White", value: "#FFFFFF" },
  { name: "Soft Grey", value: "#F1F3F5" },
  { name: "Sky", value: "#EEF5FF" },
  { name: "Mint", value: "#ECFAF3" },
  { name: "Sand", value: "#FDF6E9" },
  { name: "Lavender", value: "#F4EEFF" },
  { name: "Midnight", value: "#151821" },
];

// Curated swatches for the foreground (text) color — kept mostly dark,
// high-contrast tones since this drives readability across the app.
const FOREGROUND_OPTIONS: { name: string; value: string }[] = [
  { name: "Plum", value: "#3B0A22" },
  { name: "Charcoal", value: "#1F2933" },
  { name: "Ink", value: "#111827" },
  { name: "Slate", value: "#334155" },
  { name: "Forest", value: "#14532D" },
  { name: "Navy", value: "#1E3A5F" },
  { name: "Maroon", value: "#7A1E2C" },
  { name: "Snow", value: "#F8FAFC" },
];

// Curated swatches for the sidebar panel background — kept a touch more
// varied since the sidebar reads its own foreground/accent tokens and
// generally tolerates bolder colors than the main page background.
const SIDEBAR_OPTIONS: { name: string; value: string }[] = [
  { name: "Pure White", value: "#FFFFFF" },
  { name: "Rani Blush", value: "#FFF5F8" },
  { name: "Soft Grey", value: "#F1F3F5" },
  { name: "Sky", value: "#EEF5FF" },
  { name: "Mint", value: "#ECFAF3" },
  { name: "Sand", value: "#FDF6E9" },
  { name: "Rani Pink", value: "#D6006D" },
  { name: "Midnight", value: "#151821" },
];

function ColorSwatchGrid({
  options,
  activeColor,
  onSelect,
}: {
  options: { name: string; value: string }[];
  activeColor: string;
  onSelect: (value: string) => void;
}) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {options.map((option) => {
        const isActive = activeColor.toLowerCase() === option.value.toLowerCase();
        return (
          <button
            key={option.value}
            type="button"
            title={option.name}
            aria-label={`Set color to ${option.name}`}
            onClick={() => onSelect(option.value)}
            className={cn(
              "h-9 w-9 rounded-full border-2 transition-transform hover:scale-105",
              isActive ? "border-primary ring-2 ring-primary/40" : "border-border/60",
            )}
            style={{ backgroundColor: option.value }}
          />
        );
      })}
    </div>
  );
}

function ColorSection({
  label,
  color,
  setColor,
  resetColor,
  options,
  inputId,
}: {
  label: string;
  color: string;
  setColor: (value: string) => void;
  resetColor: () => void;
  options: { name: string; value: string }[];
  inputId: string;
}) {
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-semibold">{label} color</div>
        <button
          type="button"
          onClick={resetColor}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <RotateCcw className="size-3" />
          Reset
        </button>
      </div>

      <ColorSwatchGrid options={options} activeColor={color} onSelect={setColor} />

      <div className="mt-3 flex items-center gap-2">
        <label htmlFor={inputId} className="text-xs text-muted-foreground">
          Custom
        </label>
        <input
          id={inputId}
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          className="h-7 w-10 cursor-pointer rounded border border-border/60 bg-transparent p-0"
        />
        <span className="text-xs text-muted-foreground">{color.toUpperCase()}</span>
      </div>
    </div>
  );
}

// Lets the user pick a page background color and its text color together,
// plus the sidebar's own background/text colors — each from a curated
// palette, or a fully custom color via the native color picker. Choices
// are applied instantly and persisted so they stick across visits.
export function ThemeColorPicker() {
  const background = useBackgroundColor();
  const foreground = useForegroundColor();
  const sidebar = useSidebarColor();
  const sidebarForeground = useSidebarForegroundColor();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" aria-label="Change background, text, and sidebar colors">
          <Palette className="size-4" />
          Colors
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <Tabs defaultValue="background">
          <TabsList className="mb-3 grid w-full grid-cols-2">
            <TabsTrigger value="background">Background</TabsTrigger>
            <TabsTrigger value="sidebar">Sidebar</TabsTrigger>
          </TabsList>
          <TabsContent value="background" className="space-y-5">
            <ColorSection
              label="Background"
              color={background.color}
              setColor={background.setColor}
              resetColor={background.resetColor}
              options={BACKGROUND_OPTIONS}
              inputId="custom-bg-color"
            />
            <ColorSection
              label="Text"
              color={foreground.color}
              setColor={foreground.setColor}
              resetColor={foreground.resetColor}
              options={FOREGROUND_OPTIONS}
              inputId="custom-fg-color"
            />
          </TabsContent>
          <TabsContent value="sidebar" className="space-y-5">
            <ColorSection
              label="Sidebar"
              color={sidebar.color}
              setColor={sidebar.setColor}
              resetColor={sidebar.resetColor}
              options={SIDEBAR_OPTIONS}
              inputId="custom-sidebar-bg-color"
            />
            <ColorSection
              label="Sidebar text"
              color={sidebarForeground.color}
              setColor={sidebarForeground.setColor}
              resetColor={sidebarForeground.resetColor}
              options={FOREGROUND_OPTIONS}
              inputId="custom-sidebar-fg-color"
            />
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}