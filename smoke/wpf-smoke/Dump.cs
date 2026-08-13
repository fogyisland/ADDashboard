using System;
using System.IO;
using PackageDesigner.Models;
using PackageDesigner.Services;
using PackageDesigner.ViewModels;

var p = new PackageProject {
  Manifest = new PackageManifest { Name="collect-dump", Version="1.0.0", Type="gauge",
    Agent = new AgentConfig { MinVersion="0.1.0", Script="collect.ps1", IntervalSec=60 },
    Database = new DatabaseConfig { SchemaName="pkg_collect_dump", MetricTable="metrics", MetricSchema=new() } },
  Files = new(), RawFiles = new() };
var vm = new MetricEditorViewModel(p);
vm.ToggleMetric(vm.Catalog[0]);
vm.ToggleMetric(vm.Catalog[1]);
var tmp = Path.Combine(Path.GetTempPath(), $"collect-dump-{Guid.NewGuid():N}.pkgproj");
vm.SaveTo(tmp);
Console.WriteLine(tmp);
