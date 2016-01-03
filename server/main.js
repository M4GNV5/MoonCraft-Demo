const IP = "46.38.234.116";
const MC_VERSION = "15w51b";
const IN_USE_MSG = "Someone else or you compiled something within the last 15 seconds.<br />" +
    "You can take a look at the result by connecting to " + IP + " using Minecraft " + MC_VERSION;
const TOO_MANY_MSG = "Too many blocks try compiling less code :/";
const SUCCESS_MSG = "Join " + IP + " using Minecraft " + MC_VERSION + " and click the start button to see the result";

var WebSocketServer = require("ws").Server;
var spawn = require("child_process").spawn;
var rconOut = require("../../MoonCraft/src/output/rcon.js");
GLOBAL.options = require("./config.json");

var lastRestart;
var inUse = false;
var mcServer;
function restartServer()
{
    console.log("(re)starting minecraft server");
    if(mcServer && !mcServer.closed)
        mcServer.kill();

    mcServer = spawn("java", ["-Xmx512M", "-jar", "server.jar", "nogui"]);

    function receive(data)
    {
        console.log((data || "").toString().trim());
    }
    mcServer.stdout.on("data", receive);
    mcServer.stderr.on("data", receive);

    mcServer.on("close", function()
    {
        console.log("minecraft server closed");
        mcServer.closed = true;
        restartServer();
    });

    lastRestart = new Date().getTime();
    setTimeout(restartServer, 60 * 60 * 1000);
}
restartServer();

var wss = new WebSocketServer({ port: 6060 });
wss.on("connection", function(ws)
{
    var wsIp = ws.upgradeReq.headers['x-forwarded-for'] || ws.upgradeReq.connection.remoteAddress;
    console.log("new websocket connection from " + wsIp);

    ws.on("message", function(raw)
    {
        try
        {
            if(inUse)
            {
                console.log("in use for " + wsIp);
                ws.send(IN_USE_MSG);
            }
            else
            {
                var data = JSON.parse(raw);
                var blocks = data[0];
                var cmdBlocks = data[1];
                if(blocks.length + cmdBlocks.length > 30)
                {
                    ws.send(TOO_MANY_MSG);
                    console.log("too many blocks for " + wsIp);
                    return;
                }

                inUse = true;
                console.log("compiling for " + wsIp);
                ws.send(SUCCESS_MSG);
                rconOut(data[0], data[1]);
                setTimeout(function()
                {
                    inUse = false;
                }, 15 * 1000);
            }
        }
        catch(e)
        {
            console.log(e.toString());
            return;
        }

    });

    ws.on("error", function(err)
    {
        console.log("error with " + wsIp + " : " + err);
    });

    ws.on("close", function()
    {
        console.log("websocket connection closed " + wsIp);
    });
});
