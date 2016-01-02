String.prototype.format = function()
{
	var val = this;
	for(var i = 0; i < arguments.length; i++)
		val = val.replace(new RegExp("\\{" + i + "\\}", "g"), arguments[i]);
	return val;
};

var editor = ace.edit("editor");
editor.setTheme("ace/theme/monokai");
editor.getSession().setMode("ace/mode/lua");
editor.setOption("fontSize", 14);

var out = document.getElementById("outtext");

window.GLOBAL = window;
window.options = {
    splitterBlock: "stone",
    x: 0,
    //y: see below
    z: 0,
    length: 20,
    debug: false,
    export: false
};

var fakeFs = require("fs");
var base = require("../../MoonCraft/src/lib/base.js");
var parser = require("../../MoonCraft/src/luaparse.js");
var baseLib = require("../../MoonCraft/src/lib/baselib.js");
var compile = require("../../MoonCraft/src/compiler.js");
var toSchematic = require("../../MoonCraft/src/output/schematic.js");
var scope = require("../../MoonCraft/src/lib/Scope.js");
var naming = require("../../MoonCraft/src/lib/naming.js");
var types = require("../../MoonCraft/src/lib/types.js");
GLOBAL.scope = scope;

var oldImport = scope.get("import");

scope.set("import", function(name)
{
	var obj;
	if(name == "chat")
		obj = require("../../MoonCraft/stdlib/chat.js");
	else if(name == "title")
		obj = require("../../MoonCraft/stdlib/title.js");
	else if(name == "query")
		obj = require("../../MoonCraft/stdlib/query.js");
	else
		throw "Cannot import {0} browser demo only supports chat, title and query".format(name);

	for(var key in obj)
	{
		scope.set(key, obj[key]);
	}
});

function doIt(cb)
{
    try
    {
		var code = editor.getValue();
		fakeFs.writeFileSync("demo.lua", code);
		baseLib.import("demo.lua", true);
		base.output(cb);
    }
    catch(e)
    {
        out.innerHTML = e.toString().replace(/\n/g, "<br />");
    }

	baseLib.reset();
	base.reset();
	naming.names = {};
	types.Integer.statics = [];
}

var downloadA = document.createElement("a");
document.body.appendChild(downloadA);
downloadA.style = "display: none";
window.run = {
    showCommands: function()
    {
        options.y = 0;
        doIt(function(blocks, cmdBlocks)
        {
            var text = "<table class=\"table table-hover\"><tr><th>X</th><th>Z</th><th>Data</th><th>Command</th></tr>";

			for(var i = 0; i < cmdBlocks.length; i++)
			{
				text += "<tr><td>{0}</td><td>{1}</td><td>{2}</td><td>{3}</td></tr>"
					.format(cmdBlocks[i].x, cmdBlocks[i].z, cmdBlocks[i].data, cmdBlocks[i].command);
			}

			text += "</table>";
			out.innerHTML = text;
        });
    },
    schematic: function()
    {
		options.y = 0;
		doIt(function(blocks, cmdBlocks)
        {
			toSchematic(blocks, cmdBlocks, function(err, data)
			{
				if(err)
					out.innerHTML = err.toString();

				out.innerHTML = "Starting download...";

				var blob = new Blob([data], {type: "octet/stream"});
				var url = window.URL.createObjectURL(blob);
				downloadA.href = url;
				downloadA.download = "output.schematic";
				downloadA.click();
				window.URL.revokeObjectURL(url);

				out.innerHTML = "Download started";
			});
		});
    },
    demoServer: function()
    {
		options.y = 4;
    }
};
