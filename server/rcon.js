var net = require("net");

module.exports = function(blocks, cmdblocks, options)
{
    var cmds = [];

    for(var i = 0; i < blocks.length; i++)
    {
        var cmd = ["setblock", blocks[i].x, blocks[i].y, blocks[i].z, blocks[i].tagName, blocks[i].data, "replace"].join(" ");
        cmds.push(cmd);
    }

    for(var i = 0; i < cmdblocks.length; i++)
    {
        var data = "{Command:" + JSON.stringify(cmdblocks[i].command) + ",auto:1b}";
        var cmd = ["setblock", cmdblocks[i].x, cmdblocks[i].y, cmdblocks[i].z, "chain_command_block", cmdblocks[i].data, "replace", data].join(" ");
        cmds.push(cmd);
    }

    console.log("Sending " + cmds.length + " commands via rcon to " + options.rcon_ip + ":" + options.rcon_port);

    if(typeof options.rcon_multi == "number" && options.rcon_multi > 1)
    {
        var count = options.rcon_multi;
        var size = Math.floor(cmds.length / count);

        var index = 0;
        for(var i = 0; i < count - 1; i++)
        {
            sendCommands(cmds.slice(index, index + size), options);
            index += size;
        }
        sendCommands(cmds.slice(index), options);
    }
    else
    {
        sendCommands(cmds, options);
    }
}

function sendCommands(cmds, options)
{
    var rcon = new Rcon(options.rcon_ip, options.rcon_port);

    rcon.auth(options.rcon_password, function(err)
    {
        if(err)
            throw err;

        function next(i)
        {
            rcon.command(cmds[i], function(err, res)
            {
                if(err)
                    throw err;

                if(res == "An unknown error occurred while attempting to perform this command") //minecraft is weird sometimes
                {
                    next(i);
                    return;
                }

                i++;
                if(i < cmds.length)
                {
                    next(i);
                }
                else
                {
                    rcon.close();
                }
            });
        }
        next(0);
    });
}

function Rcon(ip, port)
{
    var self = this;
    self.nextId = 0;
    self.connected = false;
    self.authed = false;
    self.packages = [];

    self.socket = net.connect(port, ip, function()
    {
        self.connected = true;
    });
    self.socket.on("data", function(data)
    {
        var length = data.readInt32LE(0);
        var id = data.readInt32LE(4);
        var type = data.readInt32LE(8);
        var response = data.toString("ascii", 12, data.length - 2);

        if(self.packages[id])
        {
            self.packages[id](type, response);
        }
        else
        {
            console.log("unexpected rcon response", id, type, response);
        }
    });
}
Rcon.timeout = 5000;

Rcon.prototype.close = function()
{
    this.socket.end();
}

Rcon.prototype.auth = function(pw, cb)
{
    var self = this;

    if(self.authed)
        throw new Error("already authed");

    if(self.connected)
        doAuth();
    else
        self.socket.on("connect", doAuth);

    function doAuth()
    {
        self.sendPackage(3, pw, cb);
    }
};

Rcon.prototype.command = function(cmd, cb)
{
    this.sendPackage(2, cmd, cb);
};

Rcon.prototype.sendPackage = function(type, payload, cb)
{
    var self = this;
    var id = self.nextId;
    self.nextId++;

    if(!self.connected)
        throw new Error("Cannot send package while not connected");

    var length = 14 + payload.length;
    var buff = new Buffer(length);
    buff.writeInt32LE(length - 4, 0);
    buff.writeInt32LE(id, 4);
    buff.writeInt32LE(type, 8);

    buff.write(payload, 12);
    buff.writeInt8(0, length - 2);
    buff.writeInt8(0, length - 1);

    self.socket.write(buff);

    var timeout = setTimeout(function()
    {
        delete self.packages[id];
        cb("Server sent no request in " + Rcon.timeout / 1000 + " seconds");
    }, Rcon.timeout);

    self.packages[id] = function(type, response)
    {
        clearTimeout(timeout);
        var err = type >= 0 ? false : "Server sent package code " + type;
        cb(err, response, type);
    }
}
