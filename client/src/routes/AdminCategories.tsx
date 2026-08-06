import { useState } from 'react';
import { FolderTree, Plus, Trash2 } from 'lucide-react';
import { DataState } from '@/components/DataState';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ApiError } from '@/lib/api';
import { useCategories, type Category } from '@/lib/catalogue';
import { useDeleteCategory, useSaveCategory } from '@/lib/manage';

/**
 * Category management. Two levels only, which is a schema decision rather than a UI one:
 * `parentId` is a self-relation and services hang off leaves, so a third level would make
 * the catalogue filter ambiguous about what it includes.
 *
 * The slug is derived by the server from the name and never sent from here - a client-chosen
 * slug is a client-chosen URL, and two vendors racing on "hair-salon" would be a 409 for
 * whoever typed second.
 */
export function AdminCategories() {
  const categories = useCategories();
  const save = useSaveCategory();
  const remove = useDeleteCategory();
  const [adding, setAdding] = useState<string | 'root'>();
  const [name, setName] = useState('');

  const tree = categories.data ?? [];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Categories</h1>
          <p className="text-sm text-muted-foreground">
            Two levels. A service is filed under a leaf, so the catalogue filter always
            resolves to a definite set.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setAdding(adding === 'root' ? undefined : 'root');
            setName('');
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          New top-level category
        </Button>
      </header>

      {(save.isError || remove.isError) && (
        <Alert variant="destructive">
          <AlertTitle>
            {((save.error ?? remove.error) as ApiError).code === 'CATEGORY_IN_USE'
              ? 'This category still has services or children'
              : 'That action was refused'}
          </AlertTitle>
          <AlertDescription>
            {((save.error ?? remove.error) as ApiError).message}
          </AlertDescription>
        </Alert>
      )}

      {adding && (
        <NameForm
          label={adding === 'root' ? 'New top-level category' : 'New child category'}
          value={name}
          pending={save.isPending}
          onChange={setName}
          onCancel={() => setAdding(undefined)}
          onSubmit={() =>
            save.mutate(
              {
                body: {
                  name: name.trim(),
                  ...(adding === 'root' ? {} : { parentId: adding }),
                },
              },
              {
                onSuccess: () => {
                  setAdding(undefined);
                  setName('');
                },
              },
            )
          }
        />
      )}

      <DataState
        isLoading={categories.isLoading}
        isError={categories.isError}
        error={categories.error as ApiError}
        isEmpty={tree.length === 0}
        emptyTitle="No categories yet"
        emptyHint="Vendors need at least one before they can create a service."
        onRetry={() => void categories.refetch()}
      >
        <ul className="space-y-3">
          {tree.map((parent) => (
            <li key={parent.id} className="glass space-y-2 rounded-xl p-4">
              <Row
                category={parent}
                onAddChild={() => {
                  setAdding(adding === parent.id ? undefined : parent.id);
                  setName('');
                }}
                onDelete={() => remove.mutate({ id: parent.id })}
                pending={remove.isPending}
              />

              {(parent.children ?? []).length > 0 && (
                <ul className="space-y-1.5 border-l border-white/40 pl-4 dark:border-white/10">
                  {parent.children?.map((child) => (
                    <li key={child.id}>
                      <Row
                        category={child}
                        onDelete={() => remove.mutate({ id: child.id })}
                        pending={remove.isPending}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </DataState>
    </div>
  );
}

function Row({
  category,
  onAddChild,
  onDelete,
  pending,
}: {
  category: Category;
  onAddChild?: () => void;
  onDelete: () => void;
  pending: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="flex min-w-0 items-center gap-2">
        {onAddChild && <FolderTree className="h-4 w-4 shrink-0 text-muted-foreground" />}
        <span className="truncate font-medium">{category.name}</span>
        <code className="rounded bg-white/50 px-1.5 py-0.5 text-xs text-muted-foreground dark:bg-white/5">
          {category.slug}
        </code>
      </span>
      <span className="flex flex-wrap gap-2">
        {onAddChild && (
          <Button size="sm" variant="outline" onClick={onAddChild}>
            <Plus className="h-3.5 w-3.5" />
            Child
          </Button>
        )}
        <Button size="sm" variant="outline" disabled={pending} onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </span>
    </div>
  );
}

function NameForm({
  label,
  value,
  pending,
  onChange,
  onCancel,
  onSubmit,
}: {
  label: string;
  value: string;
  pending: boolean;
  onChange: (v: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <form
      className="glass flex flex-wrap items-end gap-2 rounded-xl p-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="min-w-[12rem] flex-1 space-y-1.5">
        <Label htmlFor="cat-name">{label}</Label>
        <Input
          id="cat-name"
          required
          minLength={2}
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Hair &amp; grooming"
        />
      </div>
      <Button type="submit" size="sm" disabled={pending || value.trim().length < 2}>
        {pending ? 'Saving...' : 'Create'}
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}
