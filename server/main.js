var mc = require('minecraft-protocol');
var WebSocketServer = require("ws").Server;
var rconOut = require("./rcon.js");

var options = require("./config.json");
var sockets = {};

var client = mc.createClient({
    host: options.mc_ip,
    port: options.mc_port,
    username: "MoonCraft",
    version: "1.9"
});
client.on('chat', function(packet)
{
    try
    {
        function parseTellraw(obj)
        {
            var message = "";
            if(typeof obj == "string")
                return obj;
            else if(obj.text)
                message += obj.text;

            if(obj.extra instanceof Array)
            {
                obj.extra.forEach(function(val)
                {
                    if(typeof val == "string")
                        message += val;
                    else if(val.text)
                        message += val.text;
                    else if(val.score)
                        message += val.score.value;
                });
            }
            return message;
        }

        var msg = JSON.parse(packet.message);
        var text;
        if(msg.translate == "chat.type.announcement" || msg.translate == "chat.type.text")
        {
            var user = msg.with[0].text;
            text = "[" + user + "] " + parseTellraw(msg.with[1]);
        }
        else
        {
            text = parseTellraw(msg);
        }

        for(var key in sockets)
        {
            sockets[key].send(text);
        }
    }
    catch(e)
    {
        console.log("error sending chat to browsers: " + e);
    }
});

function log(ip, msg)
{
    var text = [
        "[",
        Date.now(),
        "] <",
        ip,
        ">\t: ",
        msg
    ].join("");
    console.log(text);
}

var wss = new WebSocketServer({ port: 6060 });
wss.on("connection", function(ws)
{
    var wsIp = ws.upgradeReq.headers['x-forwarded-for'] || ws.upgradeReq.connection.remoteAddress;
    log(wsIp, "connected");
    sockets[wsIp] = ws;

    ws.on("message", function(raw)
    {
        try
        {
            var data = JSON.parse(raw);
            var blocks = data[0];
            var cmdBlocks = data[1];
            var blockCount = blocks.length + cmdBlocks.length;
            if(blockCount > 30)
            {
                log(wsIp, "too many blocks");
                ws.send(options.msg_toomany);
                return;
            }

            log(wsIp, "compiling " + blockCount + " commands");
            ws.send(options.msg_success.replace(/\{count\}/ig, blockCount));

            rconOut(blocks, cmdBlocks, options);
        }
        catch(e)
        {
            log(wsIp, "/!\\ " + e);
            return;
        }

    });

    ws.on("error", function(err)
    {
        log(wsIp, "websocket error: " + err);
        delete sockets[wsIp];
    });

    ws.on("close", function()
    {
        log(wsIp, "disconnected");
        delete sockets[wsIp];
    });
});
