# WPF Package Designer — Blank UI After "New" Review

Reviewed: `wpf-fix.diff` (12 KB, staged, uncommitted) + the working tree of the
WPF project. Build clean (0 warnings, 0 errors), 68/68 tests pass, no recent
`.NET Runtime` / `Application Error` events in the last 15 min, so the symptom
is a silent binding/layout failure — not a crash.

---

## Root cause

**`MainWindowViewModel` does not implement `INotifyPropertyChanged`, but
`MainWindow.xaml` TwoWay-binds `TabControl.SelectedItem` and `TabControl.ItemsSource`
to it.**

The `ActiveTab` property is a plain auto-property whose backing field is mutated
in the `CollectionChanged` handler. WPF only re-evaluates a TwoWay binding back
to the UI when the source raises `PropertyChanged("ActiveTab")`. It doesn't,
so `TabControl.SelectedItem` stays `null` even though `OpenTabs` now has one
item. The tab header row is empty (no `ItemTemplate` instance is realised
without a `SelectedItem` driving `ContentTemplate` first), and the welcome
`StackPanel` is wired to `OpenTabs.Count` — which DOES update, because
`ObservableCollection<T>` raises `INotifyPropertyChanged` for `Count` itself,
so the welcome panel hides correctly. That is exactly the asymmetric symptom
the user reports: welcome panel gone, no tab, no form, no tree, no errors.

Three independent chains, one root cause:

1. `OpenTabs.Add(...)` fires `CollectionChanged` → `ActiveTab = newTab` runs.
   The field is set, no event raised. `TabControl.SelectedItem` binding sees no
   `PropertyChanged("ActiveTab")`, leaves `SelectedItem == null`. No
   `ContentTemplate` materialises. → blank content area.
2. `OpenTabs` itself DOES raise `Count` changes (because it's an
   `ObservableCollection<T>`), so the `Visibility="{Binding OpenTabs.Count,
   Converter=...}"` binding does update — the welcome panel correctly hides.
   This asymmetry is the smoking gun: the user's first visible change is real,
   the second is silently not.
3. `SelectedFile` on `PackageTabViewModel` is a plain auto-property
   (`D:\ToolDevelop\ADDashboard\ViewModels\PackageTabViewModel.cs:12`). The
   inner `TabControl` in `Views/PackageTabView.xaml:10`
   (`SelectedItem="{Binding SelectedFile}"`) has the same problem. Even if
   `ContentTemplate` did materialise, no `OpenFiles[0]` would become the
   visible tab inside the package.

There is a second, **independent** root cause that the user should know about
even after fixing the binding: **`PackageTabViewModel`'s ctor calls
`OpenManifest()`, which inside `ManifestTab.View` does
`_view ??= new Views.ManifestFormView(_vm)`.** This `ManifestFormView`
construction happens *at ctor time on the click handler* (the
`ManifestTab.View` is a property, but `PackageTabViewModel`'s ctor triggers
`OpenFiles.Add(new ManifestTab(...))` which doesn't touch `View` — so the
first time `View` is read, it's the WPF render pass, not the ctor). That is
fine on the STA UI thread. **However**, `ManifestFormView` has only the
single `(ManifestViewModel vm)` ctor — that ctor is `new ManifestFormView(vm)`
which is `UserControl`-derived, so the parameterless base ctor runs first
followed by VM assignment, all on STA. This is OK at runtime, but it means
the test for `OpenManifest_Adds_Another_Tab` (which the diff adds) does
**not** exercise `ManifestTab.View` and therefore does not catch the
parameterless-ctor issue at the ManifestFormView level. So Fix 1 was
necessary but applied to the wrong class. The two view classes that have
the same defect are listed in Important findings.

There's also a **third** issue — minor in this specific symptom but
blocking `ContentTemplate` for the inner TabControl after the
`ActiveTab`/`SelectedFile` problems are fixed:

4. `PackageTabView.xaml:10` has `<TabControl ItemsSource="{Binding
   OpenFiles}" SelectedItem="{Binding SelectedFile}">`. The inner
   `ContentTemplate` uses `<ContentControl Content="{Binding View}"/>`.
   `View` is typed as `object` (returning a `UserControl`), which WPF
   cannot serialize-deserialize the way you'd expect — it just hosts the
   `UserControl` instance. This is fine, but the real issue is the missing
   INPC on `SelectedFile` and `FileTabViewModel.View` (it has no
   `PropertyChanged` raised when `View` is first materialised — see point 3
   below).

**File:line citations for the root cause:**

- `D:\ToolDevelop\ADDashboard\ViewModels\MainWindowViewModel.cs:7-27` —
  class does not implement `INotifyPropertyChanged`; `ActiveTab` is
  `{ get; set; }`; the ctor mutates the backing field without raising
  `PropertyChanged`.
- `D:\ToolDevelop\ADDashboard\MainWindow.xaml:27` —
  `SelectedItem="{Binding ActiveTab}"` is TwoWay (default for `SelectedItem`).
- `D:\ToolDevelop\ADDashboard\MainWindow.xaml:38` —
  `Visibility="{Binding OpenTabs.Count, ...}"` is fine because
  `ObservableCollection<T>` auto-raises `Count` changes. (Confirms it's a
  per-property INPC problem, not a global data-flow problem.)
- `D:\ToolDevelop\ADDashboard\ViewModels\PackageTabViewModel.cs:12` —
  `SelectedFile` is also a plain auto-property, no INPC.

---

## Critical findings (must-fix before user sees anything)

### C-1. `MainWindowViewModel` lacks `INotifyPropertyChanged`; `ActiveTab` is a plain auto-property
**File:** `D:\ToolDevelop\ADDashboard\ViewModels\MainWindowViewModel.cs:7,10,18-26`
**Symptom:** `TabControl.SelectedItem` never moves off `null` after
`OpenTabs.Add(...)`, so `ContentTemplate` never materialises → blank
content area.
**Why "Fix 2" looked correct but didn't help:** the property is mutated
in-process; the binding has no `PropertyChanged` signal to observe. Even
if you set `ActiveTab = newTab` from a button click directly, the
`TabControl` won't visually select the new item.
**Note for the user:** the existing test `Add_Tab_Sets_ActiveTab_To_Newest`
asserts `Assert.Same(t1, vm.ActiveTab)` — that passes because the *field*
is correctly mutated; the test does not and cannot catch a missing INPC
notification. INPC must be added; `SelectedItem` will then update and the
`ContentTemplate` will realise.

### C-2. `PackageTabViewModel.SelectedFile` is also a plain auto-property
**File:** `D:\ToolDevelop\ADDashboard\ViewModels\PackageTabViewModel.cs:12`
**Symptom:** Even after C-1 is fixed, the *inner* TabControl in
`PackageTabView.xaml:10` (`SelectedItem="{Binding SelectedFile}"`) will
behave the same way. The auto-opened `ManifestTab` will be in
`OpenFiles[0]` but not selected → `ContentTemplate` of the inner
TabControl never materialises → the right side of the `DockPanel` is
blank.
**Same shape as C-1** — add INPC, raise `PropertyChanged("SelectedFile")`
in the setter.

### C-3. `FileTabViewModel.View` doesn't notify on first materialisation
**File:** `D:\ToolDevelop\ADDashboard\ViewModels\FileTabViewModel.cs:6-13` + the three private subclasses in
`ViewModels\PackageTabViewModel.cs:29-52` (`ManifestTab`, `SqlFileTab`, `Ps1FileTab`)
**Symptom:** `View` is `=> _view ??= new Views.<Concrete>(_vm)`. The
`INotifyPropertyChanged` is on the base class, but `PropertyChanged` is
never raised for `"View"` when `_view` is first assigned. After C-1 and
C-2 are fixed, the inner `ContentTemplate` does materialise, the
`ContentControl` binds to `View`, and the lazy `??=` runs — but because
no `PropertyChanged("View")` fires, the `ContentControl` may render
*before* the View instance exists. In practice WPF re-evaluates the
binding on first layout pass, so this is usually OK; but if you ever
hit a "tab header shows, content blank even though `View` is
constructed" symptom, this is the cause. (Caveat: `Content` is a
`DependencyProperty`; WPF re-resolves it on `TargetUpdated` so most
cases are fine. Still — raising `OnChanged(nameof(View))` after the
first assignment is hygienic.)

---

## Important findings (would help even if blank is fixed)

### I-1. `MainWindowViewModel.OpenTabs` subscription is not `IDisposable`-cleaned
**File:** `D:\ToolDevelop\ADDashboard\ViewModels\MainWindowViewModel.cs:18`
**Note:** This is just a lambda holding `this`. The VM lives as long as
the Window, so no leak in practice. Don't bother fixing now.

### I-2. View classes that take a VM in their ctor are still not XAML-declarable
**Files:**
- `D:\ToolDevelop\ADDashboard\Views\MigrationsListView.xaml.cs:10-15` — only ctor takes `MigrationsListViewModel`. (Referenced from
  `PackageTabView.xaml`? No — currently no XAML reference; only the
  MigrationsListViewModel exists. Safe today; would break if anyone ever
  puts `<views:MigrationsListView/>` in XAML.)
- `D:\ToolDevelop\ADDashboard\Views\ManifestFormView.xaml` —
  no `.xaml.cs` shown but referenced as `new Views.ManifestFormView(_vm)`
  in `PackageTabViewModel.cs:35` (parameterless + VM assignment via
  the constructor argument). If `ManifestFormView` only has a
  `(ManifestViewModel vm)` ctor, same XamlParseException shape as
  `PackageTabView` had. Currently safe because it's only constructed
  in code; but this is the **same bug** Fix 1 fixed for PackageTabView
  lurking on another view. Worth a follow-up to give ManifestFormView
  a parameterless ctor + a `ViewModel` property setter, exactly the
  pattern Fix 1 established.

### I-3. `MainWindow.xaml` line 33: `DataContext="{Binding}"` is redundant
**File:** `D:\ToolDevelop\ADDashboard\MainWindow.xaml:33`
**Note:** When `ContentTemplate` is being applied, the `DataContext` of
the templated child is *already* the item (the `PackageTabViewModel`).
The explicit `DataContext="{Binding}"` is a no-op. Not a bug, just
visual noise.

### I-4. `OpenTabs.Remove(t2)` does not re-set `ActiveTab` if you remove a *middle* tab
**File:** `D:\ToolDevelop\ADDashboard\ViewModels\MainWindowViewModel.cs:22-23`
The `else if (e.Action == Remove && OpenTabs.Count > 0)` always picks
`OpenTabs[^1]`. If you remove a middle tab while the last tab is the
active one, the active tab changes to the new last — which is correct
behaviour, but the test (`Remove_Tab_Falls_Back_To_Last_Remaining`) only
covers removing the last one. Minor: spec ambiguity, not a defect.

### I-5. `MainWindow.xaml.cs:13` uses a field-style init `public MainWindowViewModel VM { get; } = new();`
**File:** `D:\ToolDevelop\ADDashboard\MainWindow.xaml.cs:13`
**Note:** This means tests can never substitute a mock VM. The VM
collection-subscribed in the ctor (`OpenTabs.CollectionChanged += ...`)
runs at field-init time, which is fine. If you ever need test isolation
for the window, switch to constructor injection. Not blocking.

---

## Minor findings (park for later)

### M-1. `App.xaml.cs:11-13` — `static` services with `null!` initialisers
Hides the fact that `OnStartup` can be skipped in test hosts. The
`[STAThread]`/non-STA boundary is what makes headless testing of the
Window impossible, so this never bites — but it's a latent papercut.

### M-2. `MainWindow.xaml:38` — `OpenTabs.Count` binding has no fallback for `null`
`ObservableCollection<T>.Count` is `int`, never `null`, so `ZeroToVisibilityConverter`
gets a value, fine. But if anyone refactors `OpenTabs` to a non-OC
collection, the welcome panel could silently break. Not a current
defect.

### M-3. `PackageTabView.xaml.cs:14` — `ViewModel` cast can throw
`ViewModel => (PackageTabViewModel)DataContext;` is called in
`Tree_SelectedItemChanged`. If the user clicks the tree before WPF
sets the DataContext, this throws `InvalidCastException`. In practice
WPF sets `DataContext` before any UI event fires, so this is fine —
but a `as`-cast with null-guard would be safer.

### M-4. `MigrationsListViewModel.Add` duplicates state into both `Items` and `_p.Files`
**File:** `D:\ToolDevelop\ADDashboard\ViewModels\MigrationsListViewModel.cs:18-25`
Two sources of truth; not a UI bug, but a smell. Park for future
refactor.

### M-5. `OpenTabs` field-init triggers `CollectionChanged` subscription on a fresh collection
**File:** `D:\ToolDevelop\ADDashboard\ViewModels\MainWindowViewModel.cs:9,18`
C# evaluates field initialisers before ctor body, so by the time the
ctor lambda is wired up, `OpenTabs` is already a fresh `ObservableCollection`.
Fine. Just noting because someone might assume field-init-then-ctor order
matters here.

---

## Test plan to verify the fix

The fix touches binding push from VM→UI. There's no headless harness for
WPF data binding, so the only authoritative check is **launch the app and
click**. The test plan below is the order to run, the buttons to click,
and the things to look for. If any step shows something other than
"expected", stop and capture a screenshot.

### Pre-flight (no user action)

1. `cd D:\ToolDevelop\ADDashboard && dotnet build PackageDesigner.csproj` → 0 warnings, 0 errors.
2. `dotnet test PackageDesigner.Tests.csproj` → all 68 tests pass.
3. Confirm no in-flight process: `powershell.exe -Command "Get-Process -Name PackageDesigner -ErrorAction SilentlyContinue"`.
4. Optionally, verify the produced `.exe` exists: `ls bin/PackageDesigner/Debug/net8.0-windows/win-x64/PackageDesigner.exe`.

### Manual run

5. Launch the binary (do **not** use F5 from VS — F5 attaches a debugger
   that masks some binding failures):
   `start "" "D:\ToolDevelop\ADDashboard\bin\PackageDesigner\Debug\net8.0-windows\win-x64\PackageDesigner.exe"`.
6. **Expected at launch:** Welcome panel centered, with "Package
   Designer" title, subtitle, and two buttons "New…" / "Open…". The
   tab strip at the top is empty.
7. Click **New…** in the menu (or the centered "New…" button on the
   welcome panel).
8. In the New Package dialog, type a name (e.g. `pkg-1`), leave
   `Template` on default, click **OK**.
9. **Expected immediately after click:** dialog closes; the welcome
   panel disappears; a new tab appears in the tab strip with the
   package name `pkg-1`; the content area below the strip shows:
   - A 240-px-wide tree on the left with three nodes: `manifest`,
     `migrations`, `collect.ps1`.
   - A second tab strip on the right, with one selected tab labeled
     `manifest`. The manifest form is rendered with: Name=textbox (with
     "pkg-1"), Version, Type, Description, Agent Type, MinVersion,
     Script, IntervalSec, TimeoutMs, SchemaName, MetricTable, plus a
     Migrations list + add/remove row.
10. Click `migrations` in the left tree → a new tab opens in the right
    strip labeled by file path (no item selected, so an empty form is
    expected).
11. Click `collect.ps1` in the left tree. If the project has no PS1 file
    yet, nothing visible happens (the `FirstOrDefault` returns null and
    the handler bails — this is by design, the user adds PS1 files via
    the manifest Script field). If a PS1 was loaded from a starter
    template, a new tab opens with the PS1 editor.
12. Open the **File** menu → **Open…** → load any existing `.pkgproj`
    file from the workspace. → a second tab opens, auto-selected, with
    its own tree + manifest form.
13. Close one of the two tabs by clicking the X. → remaining tab stays
    selected. Close the last tab → welcome panel reappears.

### Negative checks (things to confirm DON'T happen)

14. No unhandled exception dialogs. If one appears, capture the stack
    trace — it is the binding source for any subsequent blank.
15. Event log clean: `powershell.exe -NoProfile -ExecutionPolicy Bypass
    -File C:\tmp\eventlog-check.ps1` (the helper you used during this
    review) should still show 0 `.NET Runtime` / `Application Error`
    entries from `PackageDesigner` after the manual run.
16. The tab content area is **never** zero-height: if it is, the issue
    is layout (Grid row sizing, not the binding). In
    `MainWindow.xaml:26-47` the Grid is implicit-sized; check
    `MainWindow`'s `Width`/`Height` aren't pinned to 0.

### What success looks like in one sentence

> After clicking New → OK, a tab appears with the package name and the
> right side of the tab shows a 240-px tree + a manifest form with the
> entered name pre-filled in the Name field. Welcome panel is gone.

If steps 9 / 10 don't show content, **C-1 and C-2 are not fully
resolved** — re-check that `PropertyChanged("ActiveTab")` and
`PropertyChanged("SelectedFile")` are raised on every setter call,
including the collection-driven mutation in
`MainWindowViewModel.cs:21,23,25`.
