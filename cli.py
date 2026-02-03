#!/usr/bin/env python3
"""CLI script to test the task management system."""

from task_manager import TaskManager

def print_menu():
    """Print the CLI menu."""
    print("\nTask Management System")
    print("1. Add Task")
    print("2. Remove Task")
    print("3. List Tasks")
    print("4. Update Task Status")
    print("5. Update Task Priority")
    print("6. Exit")

def main():
    manager = TaskManager()
    
    while True:
        print_menu()
        choice = input("Enter your choice: ")
        
        if choice == "1":
            title = input("Enter task title: ")
            priority = int(input("Enter task priority (1-5): "))
            task = manager.add_task(title, priority)
            print(f"Added task: {task}")
        
        elif choice == "2":
            task_id = int(input("Enter task ID to remove: "))
            if manager.remove_task(task_id):
                print(f"Task {task_id} removed successfully.")
            else:
                print(f"Task {task_id} not found.")
        
        elif choice == "3":
            tasks = manager.list_tasks()
            if not tasks:
                print("No tasks found.")
            else:
                for task in tasks:
                    print(task)
        
        elif choice == "4":
            task_id = int(input("Enter task ID to update status: "))
            status = input("Enter new status (pending/completed/in-progress): ")
            if manager.update_task_status(task_id, status):
                print(f"Task {task_id} status updated to '{status}'.")
            else:
                print(f"Task {task_id} not found.")
        
        elif choice == "5":
            task_id = int(input("Enter task ID to update priority: "))
            priority = int(input("Enter new priority (1-5): "))
            if manager.update_task_priority(task_id, priority):
                print(f"Task {task_id} priority updated to {priority}.")
            else:
                print(f"Task {task_id} not found.")
        
        elif choice == "6":
            print("Exiting...")
            break
        
        else:
            print("Invalid choice. Please try again.")

if __name__ == "__main__":
    main()