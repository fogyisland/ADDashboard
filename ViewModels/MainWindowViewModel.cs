using System;
using System.Collections.ObjectModel;
using System.Collections.Specialized;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Threading;
using PackageDesigner.Models;

namespace PackageDesigner.ViewModels;

public class MainWindowViewModel : INotifyPropertyChanged
{
    public ObservableCollection<PackageTabViewModel> OpenTabs { get; } = new();

    // Session counter for "Untitled Document N" default names. Increments
    // atomically across the app lifetime; never reuses a number even if an
    // earlier untitled tab is closed without saving (matches Office behavior).
    private static int _untitledCounter;

    /// <summary>Returns the next default display name for a brand-new package,
    /// e.g. <c>未命名文档1</c>, <c>未命名文档2</c>, ...</summary>
    public string NextUntitledName() =>
        $"未命名文档{Interlocked.Increment(ref _untitledCounter)}";

    private PackageTabViewModel? _activeTab;
    public PackageTabViewModel? ActiveTab
    {
        get => _activeTab;
        set { if (_activeTab != value) { _activeTab = value; OnChanged(); } }
    }

    public MainWindowViewModel()
    {
        // Keep ActiveTab in sync with the most recently opened package so
        // MainWindow.TabControl.SelectedItem always points to a tab whose
        // content area renders. Without this, the tab header shows but the
        // ContentTemplate is unbound → blank middle.
        OpenTabs.CollectionChanged += (_, e) =>
        {
            if (e.Action == NotifyCollectionChangedAction.Add && e.NewItems is { Count: > 0 })
                ActiveTab = (PackageTabViewModel)e.NewItems[^1]!;
            else if (e.Action == NotifyCollectionChangedAction.Remove && OpenTabs.Count > 0)
                ActiveTab = OpenTabs[^1];
            else if (e.Action == NotifyCollectionChangedAction.Reset)
                ActiveTab = null;
        };
    }

    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnChanged([CallerMemberName] string? name = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}
