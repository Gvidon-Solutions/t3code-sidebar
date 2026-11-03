import { useState } from "react";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogPanel } from "../ui/dialog";
import { Input } from "../ui/input";
import { Button } from "../ui/button";

export function MoveProjectDialog<
  T extends { readonly id: string; readonly environmentId: string; readonly title: string },
>(props: {
  readonly projects: readonly T[];
  readonly label: (project: T) => string;
  readonly onSelect: (project: T) => void;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Move to project…</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <Input
            aria-label="Search projects"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="mt-3 flex max-h-80 flex-col gap-1 overflow-auto">
            {props.projects
              .filter((project) => props.label(project).toLowerCase().includes(query.toLowerCase()))
              .map((project) => (
                <Button
                  key={`${project.environmentId}:${project.id}`}
                  variant="ghost"
                  onClick={() => props.onSelect(project)}
                >
                  {props.label(project)}
                </Button>
              ))}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
