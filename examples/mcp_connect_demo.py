"""
MCP Servers Connection Demo.

Connects to multiple MCP servers and demonstrates their capabilities.
"""
#hello there 
import asyncio
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.progress import Progress, SpinnerColumn, TextColumn


console = Console()

##hello atharv here is the code for mcp connection demo
async def demo_mcp_connections():
    """Connect to MCP servers and show their capabilities."""
    
    console.print(Panel.fit(
        "[bold cyan]🔌 MCP Servers Connection Demo[/bold cyan]\n"
        "[dim]Connecting to Model Context Protocol servers[/dim]",
        border_style="cyan",
    ))
    console.print()
    
    # Import MCP modules
    from mcp.servers_config import AVAILABLE_SERVERS, get_no_config_servers
    from mcp.connection_manager import get_connection_manager, ConnectionStatus
    
    manager = get_connection_manager()
    
    # Show available servers
    console.print("[bold]📦 Available MCP Servers:[/bold]")
    console.print()
    
    table = Table(show_header=True)
    table.add_column("Server", style="cyan")
    table.add_column("Description")
    table.add_column("Requires Config", style="yellow")
    
    for name, server in AVAILABLE_SERVERS.items():
        requires = ", ".join(server.requires_config) if server.requires_config else "None"
        table.add_row(name, server.description[:50], requires)
    
    console.print(table)
    console.print()
    
    # Get servers that don't need config
    no_config = get_no_config_servers()
    console.print(f"[bold]🚀 Servers ready to connect (no API keys needed): {len(no_config)}[/bold]")
    console.print(f"   {', '.join(s.name for s in no_config)}")
    console.print()
    
    # Try to connect to each server
    console.print("[bold]🔄 Attempting connections...[/bold]")
    console.print()
    
    results = {
        "connected": [],
        "failed": [],
    }
    
    # We'll try to connect to servers that might work
    # Note: These require npx/node to be installed
    test_servers = ["filesystem", "memory", "fetch", "time", "git"]
    
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        console=console,
    ) as progress:
        
        for server_name in test_servers:
            if server_name not in AVAILABLE_SERVERS:
                continue
            
            server_def = AVAILABLE_SERVERS[server_name]
            task = progress.add_task(f"Connecting to {server_name}...", total=1)
            
            try:
                conn = await manager.connect(
                    name=server_def.name,
                    transport=server_def.transport,
                    command=server_def.command,
                    args=server_def.args,
                    env=server_def.env,
                )
                
                if conn.status == ConnectionStatus.CONNECTED:
                    results["connected"].append({
                        "name": server_name,
                        "tools": conn.tools,
                        "resources": conn.resources,
                    })
                    progress.update(task, description=f"[green]✅ {server_name}: {len(conn.tools)} tools[/green]")
                else:
                    results["failed"].append({
                        "name": server_name,
                        "error": conn.error_message,
                    })
                    progress.update(task, description=f"[red]❌ {server_name}: {conn.error_message[:40]}[/red]")
                    
            except Exception as e:
                results["failed"].append({
                    "name": server_name,
                    "error": str(e),
                })
                progress.update(task, description=f"[red]❌ {server_name}: {str(e)[:40]}[/red]")
            
            progress.update(task, completed=1)
            await asyncio.sleep(0.5)  # Brief pause for UI
    
    console.print()
    
    # Show results
    if results["connected"]:
        console.print("[bold green]✅ Connected Servers:[/bold green]")
        
        for server in results["connected"]:
            console.print(f"\n  [cyan]{server['name']}[/cyan]")
            
            if server["tools"]:
                console.print(f"    Tools ({len(server['tools'])}):")
                for tool in server["tools"][:5]:  # Show first 5
                    desc = tool.get("description", "")[:50]
                    console.print(f"      • {tool.get('name', 'unknown')}: {desc}")
                if len(server["tools"]) > 5:
                    console.print(f"      ... and {len(server['tools']) - 5} more")
            
            if server["resources"]:
                console.print(f"    Resources ({len(server['resources'])}):")
                for res in server["resources"][:3]:
                    console.print(f"      • {res.get('name', 'unknown')}")
    
    if results["failed"]:
        console.print()
        console.print("[bold red]❌ Failed Connections:[/bold red]")
        for server in results["failed"]:
            console.print(f"  {server['name']}: {server['error']}")
    
    # Show aggregated stats
    console.print()
    stats = manager.get_stats()
    console.print(Panel(
        f"[bold]MCP Connection Summary[/bold]\n\n"
        f"Connected Servers: {stats['connected']}/{stats['total_servers']}\n"
        f"Total Tools Available: {stats['total_tools']}\n"
        f"Total Calls Made: {stats['total_calls']}",
        border_style="green" if stats['connected'] > 0 else "red",
    ))
    
    # Cleanup
    console.print()
    console.print("[dim]Disconnecting...[/dim]")
    await manager.disconnect_all()
    console.print("[green]Done![/green]")
    
    return results


async def quick_check():
    """Quick check if npx is available."""
    import subprocess
    
    try:
        result = subprocess.run(
            ["npx", "--version"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            console.print(f"[green]✅ npx available: v{result.stdout.strip()}[/green]")
            return True
        else:
            console.print("[yellow]⚠️ npx not available. Install Node.js to use MCP servers.[/yellow]")
            return False
    except FileNotFoundError:
        console.print("[yellow]⚠️ npx not found. Install Node.js from https://nodejs.org[/yellow]")
        return False
    except Exception as e:
        console.print(f"[yellow]⚠️ Error checking npx: {e}[/yellow]")
        return False


async def main():
    """Main entry point."""
    console.print()
    
    # Check prerequisites
    has_npx = await quick_check()
    console.print()
    
    if has_npx:
        await demo_mcp_connections()
    else:
        console.print(Panel(
            "[bold yellow]MCP Server Prerequisites[/bold yellow]\n\n"
            "To connect to MCP servers, you need:\n"
            "1. [cyan]Node.js[/cyan] installed (includes npx)\n"
            "2. Internet connection (first run downloads servers)\n\n"
            "Install Node.js: https://nodejs.org\n\n"
            "[dim]After installing, run this demo again.[/dim]",
            border_style="yellow",
        ))
        
        # Still show what's available
        from mcp.servers_config import AVAILABLE_SERVERS
        
        console.print()
        console.print("[bold]Available servers (once Node.js is installed):[/bold]")
        for name, server in AVAILABLE_SERVERS.items():
            status = "🔑" if server.requires_config else "✅"
            console.print(f"  {status} {name}: {server.description[:60]}")


if __name__ == "__main__":
    asyncio.run(main())
