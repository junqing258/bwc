import { useRef } from "react";
import { Ellipsis, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export default function ProjectActions({
  name,
  disabled,
  onEdit,
  onRemove,
}: {
  name: string;
  disabled: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const actionSelected = useRef(false);
  function act(action: () => void) {
    actionSelected.current = true;
    action();
  }
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="mr-[5px] h-7 w-[26px] rounded-sm text-muted-foreground hover:bg-secondary hover:text-secondary-foreground"
          aria-label={`${name}的更多操作`}
          title="更多操作"
          disabled={disabled}
        >
          <Ellipsis aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-36"
        aria-label={`${name}的项目操作`}
        onCloseAutoFocus={(event) => {
          // Keep focus in the project dialog opened by the selected action.
          if (actionSelected.current) event.preventDefault();
          actionSelected.current = false;
        }}
      >
        <DropdownMenuItem onSelect={() => act(onEdit)}>
          <Pencil aria-hidden="true" />
          编辑
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={() => act(onRemove)}>
          <Trash2 aria-hidden="true" />
          移除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
